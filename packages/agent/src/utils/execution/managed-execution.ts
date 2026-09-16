import { isBlank, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ExecutionRecord } from '../../types/agent.js'
import type { ExecutionGuidanceEnqueueResult } from '../../types/records.js'

/**
 * 把 `AbortController.signal.reason` 这种任意值规成一句写进中止事件的原因：非空白字符串原样用，
 * `Error` 取 `message`，其余（undefined、空白串、随手扔的对象）一律回退到固定文案。
 * 目的是保证界面上永远有一句可读的中止原因，不会渲染出 `undefined` 或 `[object Object]`。
 */
export function resolveAbortReason(reason: unknown): string {
  if (isString(reason) && !isBlank(reason)) return reason
  if (reason instanceof Error && !isBlank(reason.message)) return reason.message
  return '运行被终止'
}

/** completed / aborted / failed 三个是终态：到了终态的执行不再被自动改写，任何二次流转都必须先过这道判定。 */
export function isTerminalExecutionStatus(status: ExecutionRecord['status']): boolean {
  return status === 'aborted' || status === 'completed' || status === 'failed'
}

/**
 * 运行中引导入队结果的断言：`accepted` 直接放行；`closed`（执行已进入收尾）与 `invalid`（空消息或不是用户消息）
 * 各自抛 `VALIDATION`，两种原因分别给话——把它们合成一句会让用户分不清「发晚了」和「发错了」。
 */
export function assertGuidanceEnqueued(
  result: ExecutionGuidanceEnqueueResult,
  invalidMessage: string
): void {
  if (result.status === 'accepted') return
  if (result.status === 'closed') {
    throw new AppError('VALIDATION', '当前执行已进入收尾，无法再接受运行中引导。')
  }
  throw new AppError('VALIDATION', invalidMessage)
}
