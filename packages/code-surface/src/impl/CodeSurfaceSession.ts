/**
 * 会话层：把一次「模型交了段程序」办完。
 *
 * 顺序是硬的——**先 typecheck，不过就不执行**。这一关拦掉的是模型对回执形状的误解；
 * 让不合法的程序跑起来，等于用真实副作用去试错。
 */

import { isEmpty, isString, isTrue } from '@velaros-ai/core'

import { CodeSurfaceErrorCodes, CodeSurfaceLimits } from '../contract/constants.js'
import type { CodeCapabilityPort, CodeRunnerApi, CodeSurfaceEventSink } from '../contract/requires.js'
import type {
  CodeAttachment,
  CodeCallNotice,
  CodeProgramRequest,
  CodeSurfaceOutcome,
  CompletedCall,
} from '../types/code-surface.js'
import type { GrantedModule } from '../types/code-surface.js'
import { fitAttachmentsToBudget } from '../utils/budget.js'
import { isRefusal } from '../utils/capability-failure.js'
import { hasNamedExports, readProgramImports, rewriteModuleForIsolate } from '../utils/module-form.js'
import { composeProgramResult, describeProgramOversize, resolveProgramSource } from '../utils/result.js'
import { CodeSurfaceTuning } from '../utils/tuning.js'

import type { CodeProgramCheckerApi } from './CodeProgramChecker.js'

/** 代码面会话。 */
export interface CodeSurfaceSessionApi {
  /**
   * 办完一次程序：查体量 → typecheck → 隔离里跑 → 把能力调用转给宿主 → 编成给模型看的结果。
   * `declarations` 是这一轮给模型看的能力声明，检查用的就是它——两边同一份，模型写得出来的就检查得过。
   */
  submit(input: {
    program: CodeProgramRequest
    /**
     * 这一轮授给程序的能力模块（常驻的 + 本会话已导入的）。
     * **只给授权的**：没授权的模块 `import` 不出来，这道闸是语言给的。
     */
    granted: readonly GrantedModule[]
    /**
     * 上一份程序的正文，宿主记着并给进来；模型传 `edits` 时在它上面改。
     * 不给而模型又传了 `edits`，会被明确拒绝并让它改发整份——**不猜一份出来**。
     */
    previousSource?: string
    /** 这个空间挂的各能力模块的代码模版（模块名 → 正文）：程序在 `velar:program` 里用 `template()` 读。不给就是没有模版可读。 */
    templates?: Readonly<Record<string, string>>
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
    previousSource?: string
    templates?: Readonly<Record<string, string>>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<CodeSurfaceOutcome> {
    const resolved = resolveProgramSource(input.program, input.previousSource)
    if ('failed' in resolved) return { checked: true, result: { failed: resolved.failed } }
    const source = resolved.source

    const oversized = describeProgramOversize(source, input.program.blobs)
    if (isString(oversized)) return {
        checked: true,
        result: { failed: { code: CodeSurfaceErrorCodes.tooLarge, message: oversized } },
      }

    // 非常驻能力必须先导入才能用：import 了没授权的模块时**一行都不执行**，回它们的签名让模型重写。
    // 这不是失败，是「先拿说明书」——代码面里写错一处的代价是整段程序不执行，不是一次调用失败。
    const missing = this.checker.missingModules({ source, granted: input.granted })
    if (!isEmpty(missing)) return { checked: false, needsModules: missing }

    const checked = this.checker.check({ source, granted: input.granted })
    if (!checked.ok) return { checked: false, check: checked }

    const notices: CodeCallNotice[] = []
    if (isTrue(checked.wroteTypeScript)) {
      notices.push({
        call: 'program',
        action: 'normalized',
        detail: '这次的程序里有 TypeScript 语法，已经替你剥掉后执行。下次直接写 JavaScript。',
      })
    }
    // 执行账：每一笔**已经落定**的能力调用都记一条。中止/超时/抛错时它是模型唯一的「我做到哪了」。
    const completed: CompletedCall[] = []
    // 还没落定的调用：程序停下时它们没人等了，一律叫停并列给模型——副作用可能做了一半。
    const inFlight = new Map<number, string>()
    // 这一轮自己的取消信号：外面停这一轮时跟着停；程序停下时用它叫停还在飞的调用。
    const run = new AbortController()
    const stopRun = (): void => run.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', stopRun, { once: true })
    // 交给模型的图：不进程序，也不进文字结果，单独收着，程序跑完跟在结果旁边回去。
    const attachments: CodeAttachment[] = []
    let calls = 0
    const outcome = await this.runner.run(
      {
        // 隔离里没有模块系统：import 改写成 __velar(...)、export default 改写成 return，行数一个不变。
        source: rewriteModuleForIsolate(checked.transpiled ?? source),
        blobs: input.program.blobs ?? {},
        operations: this.capabilities.listOperations(),
        templates: input.templates ?? {},
        timeoutMs: Math.min(input.timeoutMs ?? CodeSurfaceTuning.defaultTimeoutMs, CodeSurfaceLimits.timeoutMs),
      },
      async (call, holdClock) => {
        calls += 1
        if (calls > CodeSurfaceLimits.calls) return {
            error: {
              code: CodeSurfaceErrorCodes.tooLarge,
              message: `这次程序已经发了 ${CodeSurfaceLimits.calls} 次能力调用，到上限了。把循环收窄，或者分几次程序做。`,
            },
          }
        const name = `${call.namespace}.${call.operation}`
        this.events.callStarted?.({ ...call })
        const startedAt = Date.now()
        inFlight.set(call.callId, name)
        // 调用的时间不是程序的时间：命令跑多久由它自己的时限管，等用户点头也在调用里。开始就停表，落定再接着走。
        const release = holdClock()
        const result = await this.capabilities
          .invoke({ namespace: call.namespace, operation: call.operation, input: call.input }, run.signal)
          .finally(() => {
            release()
            inFlight.delete(call.callId)
          })
        this.events.callSettled?.({ callId: call.callId, ok: !result.error, elapsedMs: Date.now() - startedAt })
        completed.push({ call: name, ok: !result.error })
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
    const unsettled = [...inFlight.values()]
    if (!isEmpty(unsettled)) run.abort(new Error('程序已经停了，这次调用没人等了'))

    // 图先收拢：它自己也会往插手记录里记一笔「丢了几张」，得赶在文字结果编好之前。
    const shown = fitAttachmentsToBudget(attachments, notices)
    const result = composeProgramResult(outcome, notices, completed, unsettled, hasNamedExports(checked.transpiled ?? source))
    const settled: Extract<CodeSurfaceOutcome, { checked: true }> = { checked: true, result }
    const imports = readProgramImports(source)
    if (!isEmpty(imports)) settled.imports = imports
    if (!isEmpty(shown)) settled.attachments = shown
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
