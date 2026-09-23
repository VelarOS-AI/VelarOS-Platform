import { isEmpty, isObject, isTrue, Log } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { CodeSurfaceErrorCodes, ScriptOutputLimits } from '../contract/constants.js'
import type {
  CodeRunnerApi,
  ScriptProcess,
  SubprocessCodeRunnerOptions,
} from '../contract/requires.js'
import type { ScriptOutputBlock, ScriptOutputCapture } from '../types/output.js'
import type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest } from '../types/runner.js'
import type { ScriptWorkerCommand, ScriptWorkerEvent } from '../types/worker.js'
import { validateOutputOptions } from '../utils/output-capture.js'
import { describeChildExit, serveCapabilityCall } from '../utils/runner-bridge.js'
import { CodeSurfaceTuning } from '../utils/tuning.js'

/** 共享单次程序的计时、能力桥、输出采集和宿主进程回收。 */
class SubprocessCodeRunner implements CodeRunnerApi {
  public constructor(private readonly options: SubprocessCodeRunnerOptions) {}

  public run(
    request: CodeRunRequest,
    dispatch: CodeRunDispatch,
    onLog: (line: string) => void,
    signal?: AbortSignal
  ): Promise<CodeRunOutcome> {
    const logs: string[] = []
    const failure = (code: string, message: string): CodeRunOutcome => ({
      ok: false,
      logs,
      error: { code, message },
    })
    if (signal?.aborted)
      return Promise.resolve(failure(CodeSurfaceErrorCodes.aborted, '脚本被中止。'))
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
      return Promise.resolve(failure(CodeSurfaceErrorCodes.timeout, '缺少有限的执行预算。'))
    return new Promise((resolve) => {
      let process: ScriptProcess | undefined
      let launching = true
      let settled = false
      let closing = false
      let outcome: CodeRunOutcome | undefined
      let ready = false
      let stderr = ''
      let outputChars = 0
      // 超时挂在一个 scope 上，停下来时整批释放；到点必停是 INV-3。
      const timers = new TimerScope({ name: 'SubprocessCodeRunner' })
      let clock: Optional<ReturnType<TimerScope['after']>>
      let remainingMs = request.timeoutMs
      let runningSince = Date.now()
      let holds = 0
      const early: unknown[] = []
      const pendingCalls = new Set<number>()
      const output: {
        config: ScriptOutputCapture['config']
        blocks: ScriptOutputBlock[]
        issues: string[]
      } = { config: {}, blocks: [], issues: [] }
      const finish = (): void => {
        if (launching || !settled || closing) return
        closing = true
        const captured =
          !isEmpty(output.blocks) || !isEmpty(output.issues) || !isEmpty(Object.keys(output.config))
            ? output
            : undefined
        void Promise.resolve()
          .then(() => process?.terminate())
          .then(
            () => resolve({ ...outcome!, output: captured }),
            (error: unknown) =>
              resolve({
                ...failure(
                  CodeSurfaceErrorCodes.runnerCrashed,
                  `隔离进程回收失败：${String(error)}`
                ),
                pendingCalls: outcome!.pendingCalls,
                output: captured,
              })
          )
      }
      const stop = (result: CodeRunOutcome): void => {
        if (settled) return
        settled = true
        outcome = { ...result, pendingCalls: [...pendingCalls] }
        timers.dispose()
        signal?.removeEventListener('abort', onAbort)
        early.length = 0
        finish()
      }
      const fail = (code: string, message: string): void => stop(failure(code, message))
      const onAbort = (): void => fail(CodeSurfaceErrorCodes.aborted, '脚本被中止。')
      const arm = (): void => {
        if (settled) return
        runningSince = Date.now()
        clock = timers.after(
          Math.max(0, remainingMs),
          () =>
            fail(CodeSurfaceErrorCodes.timeout, `脚本超过 ${request.timeoutMs}ms 没跑完，已终止。`),
          { label: 'program-timeout' }
        )
      }
      const holdClock = (): (() => void) => {
        if (settled) return () => undefined
        if (holds === 0) {
          timers.cancel(clock)
          remainingMs -= Date.now() - runningSince
        }
        holds += 1
        let released = false
        return () => {
          if (released || settled) return
          released = true
          holds -= 1
          if (holds === 0) arm()
        }
      }
      const send = (message: ScriptWorkerCommand): void => {
        if (settled) return
        try {
          void Promise.resolve(process!.send(message)).catch((error: unknown) => {
            if (!settled)
              fail(CodeSurfaceErrorCodes.runnerCrashed, `隔离消息投递失败：${String(error)}`)
          })
        } catch (error) {
          Log.tag('ActRuntime').debug('SubprocessCodeRunner 消息投递已进入异常处理分支')
          fail(CodeSurfaceErrorCodes.runnerCrashed, `隔离消息投递失败：${String(error)}`)
        }
      }
      const receive = (raw: unknown): void => {
        if (settled) return
        if (launching) {
          early.push(raw)
          return
        }
        if (!isObject(raw) || !('type' in raw)) {
          fail(CodeSurfaceErrorCodes.runnerCrashed, '隔离进程返回了无效消息。')
          return
        }
        const message = raw as ScriptWorkerEvent
        try {
          if (message.type === 'ready') {
            if (ready || !isTrue(message.confined)) {
              fail(CodeSurfaceErrorCodes.runnerCrashed, 'QuickJS 隔离自检失败，脚本没有执行。')
              return
            }
            ready = true
            send({ type: 'program', ...request })
            return
          }
          if (!ready) {
            fail(CodeSurfaceErrorCodes.runnerCrashed, '隔离进程尚未完成自检。')
            return
          }
          if (message.type === 'log') {
            const line = String(message.line)
            logs.push(line)
            onLog(line)
            return
          }
          if (message.type === 'call') {
            if (
              !Number.isSafeInteger(message.callId) ||
              message.callId <= 0 ||
              pendingCalls.has(message.callId)
            )
              throw new Error('隔离调用身份无效。')
            pendingCalls.add(message.callId)
            void serveCapabilityCall(message, dispatch, holdClock).then(
              (result) => {
                pendingCalls.delete(message.callId)
                send(result)
              },
              (error: unknown) => {
                pendingCalls.delete(message.callId)
                if (!settled) fail(CodeSurfaceErrorCodes.runnerCrashed, String(error))
              }
            )
            return
          }
          if (message.type === 'output') {
            const event = message.event
            if (event.config) {
              validateOutputOptions(event.config, true)
              output.config = event.config
            }
            if (event.issue && output.issues.length < ScriptOutputLimits.issues)
              output.issues.push(String(event.issue).slice(0, ScriptOutputLimits.metadataChars))
            if (event.block) {
              validateOutputOptions(event.block.options)
              const chars = JSON.stringify(event.block.value).length
              if (
                output.blocks.length >= ScriptOutputLimits.blocks ||
                outputChars + chars > ScriptOutputLimits.rawChars ||
                output.blocks.some((block) => block.key === event.block!.key)
              )
                throw new Error('隔离输出超限或身份重复')
              outputChars += chars
              output.blocks.push({ ...event.block, chars })
            }
            return
          }
          if (message.type === 'done') {
            const error = message.error
            stop({
              ok: isTrue(message.ok),
              value: message.value,
              logs,
              error:
                isTrue(message.ok)
                  ? undefined
                  : {
                      code:
                        error?.code === CodeSurfaceErrorCodes.tooLarge
                          ? CodeSurfaceErrorCodes.tooLarge
                          : error?.code === CodeSurfaceErrorCodes.timeout
                            ? CodeSurfaceErrorCodes.timeout
                            : CodeSurfaceErrorCodes.programError,
                      message:
                        error?.code === CodeSurfaceErrorCodes.tooLarge &&
                        error.message.includes('out of memory')
                          ? '脚本堆内存已到上限，请分批读取并只保留需要的数据。'
                          : (error?.message ?? '脚本失败但没给出原因。'),
                      line: error?.line,
                    },
            })
            return
          }
          fail(CodeSurfaceErrorCodes.runnerCrashed, '隔离进程返回了未知消息。')
        } catch (error) {
          Log.tag('ActRuntime').debug('SubprocessCodeRunner 消息处理已进入异常处理分支')
          fail(CodeSurfaceErrorCodes.programError, String(error))
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      arm()
      try {
        if (signal?.aborted) onAbort()
        if (!settled)
          process = this.options.launch({
            heapMb: CodeSurfaceTuning.heapMb,
            onMessage: receive,
            onError: (error) => fail(CodeSurfaceErrorCodes.runnerCrashed, String(error)),
            onExit: (code) => {
              const error = describeChildExit(code, stderr)
              fail(error.code, error.message)
            },
            onStderr: (text) => {
              if (!settled && stderr.length < CodeSurfaceTuning.stderrCaptureChars)
                stderr += text.slice(0, CodeSurfaceTuning.stderrCaptureChars - stderr.length)
            },
          })
      } catch (error) {
        Log.tag('ActRuntime').debug('SubprocessCodeRunner 启动隔离进程已进入异常处理分支')
        fail(CodeSurfaceErrorCodes.runnerCrashed, String(error))
      } finally {
        launching = false
      }
      if (settled) finish()
      else for (const message of early.splice(0)) receive(message)
    })
  }
}

/** 按宿主进程注入口创建共享隔离运行器。 */
export function createSubprocessCodeRunner(options: SubprocessCodeRunnerOptions): CodeRunnerApi {
  return new SubprocessCodeRunner(options)
}
