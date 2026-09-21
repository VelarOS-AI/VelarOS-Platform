/** 在独立进程的 QuickJS WASM 堆中执行程序，宿主仅通过 IPC 提供登记能力。 */
import { fork } from 'node:child_process'

import {Log} from '@velaros-ai/core'
import { isEmpty, isNull, isTrue } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { CodeSurfaceErrorCodes, ScriptOutputLimits } from '../contract/constants.js'
import type { CodeRunnerApi } from '../contract/requires.js'
import type { ScriptOutputBlock, ScriptOutputCapture } from '../types/output.js'
import type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest } from '../types/runner.js'
import { resolveChildPath, resolveNodeExecutable } from '../utils/node-executable.js'
import { validateOutputOptions } from '../utils/output-capture.js'
import { describeChildExit, serveCapabilityCall } from '../utils/runner-bridge.js'
import { CodeSurfaceTuning } from '../utils/tuning.js'

class NodeSubprocessCodeRunner implements CodeRunnerApi {
  public async run(
    request: CodeRunRequest,
    dispatch: CodeRunDispatch,
    onLog: (line: string) => void,
    signal?: AbortSignal
  ): Promise<CodeRunOutcome> {
    const childPath = resolveChildPath()
    const nodePath = resolveNodeExecutable()
    if (isNull(nodePath)) return {
        ok: false,
        logs: [],
        error: {
          code: CodeSurfaceErrorCodes.runnerCrashed,
          message: '本机找不到 node，隔离起不来，脚本没有执行。隔离运行器需要 Node 进程承载 QuickJS WASM。',
        },
      }
    const child = fork(childPath, [], {
      // 固定由 Node 承载受信 IPC 引导，程序运行在 QuickJS 堆中。
      execPath: nodePath,
      // 模型源码只进入 WASM；进程堆再设一道上限，超时由父进程强制终止。
      // 管不住「一个循环里把整个仓库读进一个数组」——那会把宿主机器一起拖垮。
      execArgv: [
        `--max-old-space-size=${CodeSurfaceTuning.heapMb}`,
      ],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })

    // stderr 必须有人读：管道没人收会把子进程堵死，而且堆爆时的现场只在这里。留头不留尾（见 tuning）。
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < CodeSurfaceTuning.stderrCaptureChars) stderr += chunk
    })

    const logs: string[] = []
    const output:{config:ScriptOutputCapture['config'];blocks:ScriptOutputBlock[];issues:string[]}={config:{},blocks:[],issues:[]}
    let outputChars=0
    return new Promise<CodeRunOutcome>((resolve) => {
      let settled = false
      // 超时挂在一个 scope 上，停下来时整批释放；到点必停是 INV-3。
      const timers = new TimerScope({ name: 'NodeSubprocessCodeRunner' })
      const stop = (outcome: CodeRunOutcome): void => {
        if (settled) return
        settled = true
        timers.dispose()
        signal?.removeEventListener('abort', onAbort)
        child.kill('SIGKILL')
        resolve({...outcome,output: !isEmpty(output.blocks)||!isEmpty(output.issues)||!isEmpty(Object.keys(output.config)) ? output : undefined})
      }
      const fail = (code: string, message: string): void =>
        stop({ ok: false, logs, error: { code, message } })

      // 墙钟可以停：等用户点头的时间不算程序的时间（见 HoldProgramClock）。停的是「还剩多久」，
      // 不是「什么时候到点」——恢复时按剩下的重新计时，用户想多久就多久，程序自己的预算一点不变。
      let remainingMs = request.timeoutMs
      let runningSince = Date.now()
      let holds = 0
      const arm = (): void => {
        clock = timers.after(
          remainingMs,
          () => fail(CodeSurfaceErrorCodes.timeout, `脚本超过 ${request.timeoutMs}ms 没跑完，已终止。`),
          { label: 'program-timeout' }
        )
      }
      let clock: Optional<ReturnType<TimerScope['after']>>
      arm()

      const holdClock = (): (() => void) => {
        if (holds === 0) {
          timers.cancel(clock)
          remainingMs -= Date.now() - runningSince
        }
        holds += 1
        let released = false
        return () => {
          // 恢复函数重复调只算一次：否则一次 finally 加一次显式调用会把层数减穿，钟再也不走。
          if (released) return
          released = true
          holds -= 1
          if (holds > 0) return
          runningSince = Date.now()
          arm()
        }
      }
      const onAbort = (): void => fail(CodeSurfaceErrorCodes.aborted, '脚本被中止。')
      signal?.addEventListener('abort', onAbort, { once: true })

      child.on('message', (raw: unknown) => {
        const message = raw as { type?: string; [key: string]: unknown }
        if (message.type === 'ready') {
          // 隔离**自证**不过就不把程序发进去。宿主跑在 bun 下时 fork 出来的是 bun，
          // 它不认 `--permission`，命令行看着完全正常而隔离一点没生效——只信旗标就会栽在这里。
          if (!isTrue(message.confined)) {
            fail(
              CodeSurfaceErrorCodes.runnerCrashed,
              'QuickJS 隔离自检失败，脚本没有执行。'
            )
            return
          }
          child.send({
            type: 'program',
            timeoutMs: request.timeoutMs,
            source: request.source,
            modules: request.modules,
            blobs: request.blobs,
            input: request.input,
            operations: request.operations,
            packages: request.packages,
          })
          return
        }
        if(message.type==='output'){
          try{
            const event=message.event as {config?:ScriptOutputCapture['config'];block?:ScriptOutputBlock;issue?:string}
            if(event.config){validateOutputOptions(event.config,true);output.config=event.config}
            if(event.issue&&output.issues.length<ScriptOutputLimits.issues)output.issues.push(String(event.issue).slice(0,ScriptOutputLimits.metadataChars))
            if(event.block){
              validateOutputOptions(event.block.options)
              const chars=JSON.stringify(event.block.value).length
              if(output.blocks.length>=ScriptOutputLimits.blocks||outputChars+chars>ScriptOutputLimits.rawChars||output.blocks.some(b=>b.key===event.block!.key))throw new Error('隔离输出超限或身份重复')
              outputChars+=chars;output.blocks.push({...event.block,chars})
            }
          }catch(error){Log.tag('ActRuntime').debug('NodeSubprocessCodeRunner 已进入异常处理或降级分支');fail(CodeSurfaceErrorCodes.programError,String(error))}
          return
        }
        if (message.type === 'log') {
          const line = String(message.line)
          logs.push(line)
          onLog(line)
          return
        }
        if (message.type === 'call') {
          void serveCapabilityCall(child, message, dispatch, holdClock)
          return
        }
        if (message.type === 'done') {
          const error = message.error as Optional<{ code?: string; message?: string; line?: number }>
          stop({
            ok: isTrue(message.ok),
            value: message.value,
            logs,
            error: isTrue(message.ok)
              ? undefined
              : {
                  code: error?.code === CodeSurfaceErrorCodes.tooLarge ? CodeSurfaceErrorCodes.tooLarge : error?.code === CodeSurfaceErrorCodes.timeout ? CodeSurfaceErrorCodes.timeout : CodeSurfaceErrorCodes.programError,
                  message: error?.code === CodeSurfaceErrorCodes.tooLarge&&error.message?.includes('out of memory') ? '脚本堆内存已到上限，请分批读取并只保留需要的数据。' : error?.message ?? '脚本失败但没给出原因。',
                  line: error?.line,
                },
          })
        }
      })

      // 认 close 不认 exit：exit 在进程退出那一刻就响，stderr 里的现场此时可能还没读完，
      // 堆爆会因此被报成一句没信息的「意外退出」。close 等 stdio 收完才响。
      child.on('close', (code) => {
        const exit = describeChildExit(code, stderr)
        fail(exit.code, exit.message)
      })
      child.on('error', (error) => fail(CodeSurfaceErrorCodes.runnerCrashed, error.message))
    })
  }

}

/** 开发期用的那一个隔离运行器；正式发版前必须换掉（见类上方说明与 INV-5）。 */
export const nodeSubprocessCodeRunner: CodeRunnerApi = new NodeSubprocessCodeRunner()

/** 这个运行器是不是可以拿去发版：恒为 false，宿主装配时据此拦下。 */
export const NodeSubprocessRunnerIsReleaseReady: false = false
