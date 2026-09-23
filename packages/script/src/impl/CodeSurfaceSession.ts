import {Log} from '@velaros-ai/core'
import {isUndefined} from '@velaros-ai/core'
/**
 * 会话层：把一次「模型交了段程序」办完。
 *
 * 顺序是硬的——**先 typecheck，不过就不执行**。这一关拦掉的是模型对回执形状的误解；
 * 让不合法的程序跑起来，等于用真实副作用去试错。
 */
import { isEmpty, isObject, isString, isTrue } from '@velaros-ai/core'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import { CodeSurfaceErrorCodes, CodeSurfaceLimits, ScriptOutputLimits } from '../contract/constants.js'
import type { CodeCapabilityOutcome, CodeCapabilityPort, CodeRunnerApi, CodeSurfaceEventSink } from '../contract/requires.js'
import type { CodeAttachment, CodeSurfaceOutcome } from '../types/outcome.js'
import type { CodeCallNotice, CodeProgramRequest, CompletedCall } from '../types/script.js'
import type { GrantedModule, ScriptPackageDefinition } from '../types/script.js'
import { fitAttachmentsToBudget } from '../utils/budget.js'
import { foldCalls, settledCall } from '../utils/calls.js'
import { isRefusal } from '../utils/capability-failure.js'
import { hasNamedExports, rewriteModuleForIsolate } from '../utils/module-form.js'
import { composeProgramResult, describeProgramOversize } from '../utils/result.js'
import { CodeSurfaceTuning } from '../utils/tuning.js'

import type { CodeProgramCheckerApi } from './CodeProgramChecker.js'

/** 代码面会话。 */
export interface CodeSurfaceSessionApi {
  /**
   * 办完一次程序：查体量 → typecheck → 隔离里跑 → 把能力调用转给宿主 → 编成给模型看的结果。
   * 程序连同它 import 到的库里的脚本一起检查、一起送进隔离；参数与大段文本原样送进 `velaros:program`。
   */
  submit(input: {
    program: CodeProgramRequest
    /**
     * 宿主为这一次执行提供的能力声明。
     * **只给授权的**：没授权的模块 `import` 不出来，这道闸是语言给的。
     */
    granted: readonly GrantedModule[]
    /** 宿主编译的包投影，与 granted 同源。 */
    packages?: readonly ScriptPackageDefinition[]
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<CodeSurfaceOutcome>
}

class CodeSurfaceSession implements CodeSurfaceSessionApi {
  public constructor(
    private readonly checker: CodeProgramCheckerApi,
    private readonly runner: CodeRunnerApi,
    private readonly capabilities: CodeCapabilityPort,
    private readonly events: CodeSurfaceEventSink = {}
  ) {}

  public async submit(input: {
    program: CodeProgramRequest
    granted: readonly GrantedModule[]
    packages?: readonly ScriptPackageDefinition[]
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<CodeSurfaceOutcome> {
    const { program } = input
    const source = program.source
    const oversized = describeProgramOversize(source, program.blobs, program.input)
    if (isString(oversized)) return {
        checked: true,
        result: { failed: { code: CodeSurfaceErrorCodes.tooLarge, message: oversized } },
      }

    // 非常驻能力必须先导入才能用：import 了没授权的模块时**一行都不执行**，回它们的签名让模型重写。
    // 这不是失败，是「先拿说明书」——代码面里写错一处的代价是整段程序不执行，不是一次调用失败。
    const target = { source, granted: input.granted, path: program.path, modules: program.modules }
    const missing = this.checker.missingModules(target)
    if (!isEmpty(missing)) return { checked: false, needsModules: missing }

    const checked = this.checker.check(target)
    if (!checked.ok) return { checked: false, check: checked }

    const notices: CodeCallNotice[] = []
    if (isTrue(checked.wroteTypeScript)) {
      notices.push({
        call: 'program',
        action: 'normalized',
        detail: '这次的脚本里有 TypeScript 语法，已经替你剥掉后执行。下次直接写 JavaScript。',
      })
    }
    // 执行账：每一笔**已经落定**的能力调用都记一条。中止/超时/抛错时它是模型唯一的「我做到哪了」。
    const completed: CompletedCall[] = []
    // 还没落定的调用：程序停下时它们没人等了，一律叫停并列给模型——副作用可能做了一半。
    const inFlight = new Map<number, string>()
    // 保留发出身份，程序停止后的进程回收可能晚于能力自己的取消回执。
    const issued = new Map<number, string>()
    // 这一轮自己的取消信号：外面停这一轮时跟着停；程序停下时用它叫停还在飞的调用。
    const run = new AbortController()
    const stopRun = (): void => run.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', stopRun, { once: true })
    // 交给模型的图：不进程序，也不进文字结果，单独收着，程序跑完跟在结果旁边回去。
    const attachments: CodeAttachment[] = []
    let calls = 0
    // 隔离里没有模块系统：import 改写成 __velaros(...) 与 __import(...)、导出改写成登记，行数一个不变。
    const modules = Object.fromEntries(Object.entries(program.modules ?? {}).map(([path, text]) => [path, rewriteModuleForIsolate(text, { importer: path, library: true })]))
    const executionStartedAt=Date.now()
    const outcome = await this.runner.run(
      {
        source: rewriteModuleForIsolate(checked.transpiled ?? source, { importer: program.path }),
        modules,
        blobs: program.blobs ?? {},
        input: program.input,
        operations: this.capabilities.listOperations(),
        packages: input.packages,
        timeoutMs: Math.min(input.timeoutMs ?? CodeSurfaceTuning.defaultTimeoutMs, CodeSurfaceLimits.timeoutMs),
      },
      async (call, holdClock) => {
        calls += 1
        if (calls > CodeSurfaceLimits.calls) return {
            error: {
              code: CodeSurfaceErrorCodes.tooLarge,
              message: `这次脚本已经发了 ${CodeSurfaceLimits.calls} 次能力调用，到上限了。把循环收窄，或者分几次做。`,
            },
          }
        const name = `${call.namespace}.${call.operation}`
        this.events.callStarted?.({ ...call })
        const startedAt = Date.now()
        inFlight.set(call.callId, name)
        issued.set(call.callId, name)
        // 调用的时间不是程序的时间：命令跑多久由它自己的时限管，等用户点头也在调用里。开始就停表，落定再接着走。
        const release = holdClock()
        let result: CodeCapabilityOutcome
        try {
          result = await this.capabilities.invoke(
            { namespace: call.namespace, operation: call.operation, input: call.input },
            run.signal
          )
        } finally {
          release()
          inFlight.delete(call.callId)
        }
        this.events.callSettled?.({ callId: call.callId, ok: !result.error, elapsedMs: Date.now() - startedAt })
        completed.push(settledCall(name, result))
        if (result.notices) notices.push(...result.notices)
        if (result.attachments) attachments.push(...result.attachments)
        if (result.error && isRefusal(result.error.code)) {
          notices.push({ call: name, action: 'denied', detail: result.error.message })
        }
        return result
      },
      (line) => this.events.logged?.(line),
      input.signal
    )
    input.signal?.removeEventListener('abort', stopRun)
    const unsettled = outcome.pendingCalls
      ? outcome.pendingCalls.map((id) => issued.get(id)).filter(isString)
      : [...inFlight.values()]
    if (!isEmpty(unsettled)) run.abort(new Error('脚本已经停了，这次调用没人等了'))

    // 图先收拢：它自己也会往插手记录里记一笔「丢了几张」，得赶在文字结果编好之前。
    if(outcome.ok&&!isUndefined(outcome.value)){
      try{if(JSON.stringify(outcome.value).length>ScriptOutputLimits.rawChars)throw new Error('程序返回值超过原始归档上限')}
      catch(error){Log.tag('ActRuntime').debug('CodeSurfaceSession 已进入异常处理或降级分支');outcome.ok=false;outcome.error={code:'TOO_LARGE',message:String(error)}}
    }
    const outputAttachments:Array<{key:string;index:number}>=[]
    for(const block of outcome.output?.blocks??[]){
      if(block.options.type!=='image'||!block.value||!isObject(block.value) ||!('data' in block.value))continue
      try{
        const image={...(block.value as CodeAttachment),origin:'capability' as const}
        modelRequestEncoder.messages({instructions:'',materials:[],images:[image],response:{type:'text'},mode:'work',outputTokens:1})
        outputAttachments.push({key:block.key,index:attachments.length});attachments.push(image)
      }catch(error){Log.tag('ActRuntime').debug('CodeSurfaceSession 已进入异常处理或降级分支');outcome.ok=false;outcome.error={code:'PROGRAM_ERROR',message:`输出图片无效：${String(error)}`}}
    }
    if(outcome.output?.issues.length){outcome.ok=false;outcome.error={code:'PROGRAM_ERROR',message:outcome.output.issues.join('; ')}}
    const shown = fitAttachmentsToBudget(attachments, notices)
    const preview=outcome.output?.blocks.some(block=>block.options.type==='image')?{...outcome,value:{default:outcome.output.blocks.length===1?{representation:'native-image',key:outcome.output.blocks[0]!.key}:outcome.output.blocks.map(block=>block.options.type==='image'?{representation:'native-image',key:block.key}:block.value)}}:outcome
    const result = composeProgramResult(preview, notices, completed, unsettled, hasNamedExports(checked.transpiled ?? source))
    const settled: Extract<CodeSurfaceOutcome, { checked: true }> = { checked: true, result }
    settled.metrics={durationMs:Date.now()-executionStartedAt,capabilityCalls:calls,rawOutputChars:outcome.output?.blocks.reduce((sum,block)=>sum+block.chars,0)??0}
    if(outcome.output)settled.output=outcome.output
    if(!isEmpty(outputAttachments))settled.outputAttachments=outputAttachments.filter(item=>item.index<shown.length)
    if(outcome.ok&&!outcome.output?.blocks.length&&!isUndefined(outcome.value))settled.rawValue=outcome.value
    if (!isEmpty(shown)) settled.attachments = shown
    if (!isEmpty(completed)) settled.calls = foldCalls(completed)
    return settled
  }
}

/** 装一个代码面会话；运行器与能力端口由宿主给。 */
export function createCodeSurfaceSession(input: {
  checker: CodeProgramCheckerApi
  runner: CodeRunnerApi
  capabilities: CodeCapabilityPort
  events?: CodeSurfaceEventSink
}): CodeSurfaceSessionApi {
  return new CodeSurfaceSession(input.checker, input.runner, input.capabilities, input.events)
}
