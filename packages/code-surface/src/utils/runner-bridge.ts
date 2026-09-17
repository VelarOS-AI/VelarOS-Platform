/** 隔离进程与宿主之间的转发：把程序发出的一次能力调用送出去，再把结果送回来。不碰实例状态，所以不放在类里。 */

import type { ChildProcess } from 'node:child_process'

import { CodeSurfaceErrorCodes } from '../contract/constants.js'
import type { CodeRunDispatch } from '../types/runner.js'

/**
 * 转一次调用。
 *
 * **转发本身失败也必须回一条**：程序停在 `await` 上等这个 id 的回音，一条都不回它就永远醒不过来，
 * 只能等超时把整个程序杀掉——那会把一次可恢复的失败变成一次白跑。
 */
export async function serveCapabilityCall(
  child: ChildProcess,
  message: Record<string, unknown>,
  dispatch: CodeRunDispatch
): Promise<void> {
  const callId = Number(message.callId)
  try {
    const outcome = await dispatch({
      callId,
      namespace: String(message.namespace),
      operation: String(message.operation),
      input: message.input,
    })
    if (outcome.error) child.send({ type: 'result', callId, ok: false, error: outcome.error })
    else child.send({ type: 'result', callId, ok: true, value: outcome.value })
  } catch (cause) {
    child.send({
      type: 'result',
      callId,
      ok: false,
      error: {
        code: CodeSurfaceErrorCodes.runnerCrashed,
        message: cause instanceof Error ? cause.message : String(cause),
      },
    })
  }
}
