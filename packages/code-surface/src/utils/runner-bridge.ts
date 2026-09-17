/** 隔离进程与宿主之间的转发：把程序发出的一次能力调用送出去，再把结果送回来。不碰实例状态，所以不放在类里。 */

import type { ChildProcess } from 'node:child_process'

import { isNull } from '@velaros-ai/core'

import { CodeSurfaceErrorCodes } from '../contract/constants.js'
import type { CodeRunDispatch, HoldProgramClock } from '../types/runner.js'

import { CodeSurfaceTuning } from './tuning.js'

/**
 * 转一次调用。
 *
 * **转发本身失败也必须回一条**：程序停在 `await` 上等这个 id 的回音，一条都不回它就永远醒不过来，
 * 只能等超时把整个程序杀掉——那会把一次可恢复的失败变成一次白跑。
 */
export async function serveCapabilityCall(
  child: ChildProcess,
  message: Record<string, unknown>,
  dispatch: CodeRunDispatch,
  holdClock: HoldProgramClock
): Promise<void> {
  const callId = Number(message.callId)
  try {
    const outcome = await dispatch(
      {
        callId,
        namespace: String(message.namespace),
        operation: String(message.operation),
        input: message.input,
      },
      holdClock
    )
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

/**
 * 隔离进程没按流程结束时，从退出码和 stderr 尾巴上判出一句能用的话。
 *
 * 堆爆了要单独认出来：V8 是**直接 abort**，不抛异常、`done` 也发不出来，
 * 光看退出码只会报成「意外退出」，模型下一轮照样把整个仓库读进一个数组。
 */
export function describeChildExit(code: Nullable<number>, stderr: string): {
  code: string
  message: string
} {
  if (stderr.includes('heap out of memory')) return {
      code: CodeSurfaceErrorCodes.tooLarge,
      message:
        `程序把 ${CodeSurfaceTuning.heapMb}MB 堆用光了，已被终止。` +
        '别把结果整个攒在内存里——边拿边筛、只留要用的那几个字段，或者分几次程序做。',
    }
  const quoted = stderr.slice(0, CodeSurfaceTuning.stderrQuoteChars).trim()
  const why = isNull(code) ? '被信号杀掉' : `码 ${code}`
  return {
    code: CodeSurfaceErrorCodes.runnerCrashed,
    message: quoted.length === 0 ? `隔离进程意外退出，${why}。` : `隔离进程意外退出，${why}：${quoted}`,
  }
}
