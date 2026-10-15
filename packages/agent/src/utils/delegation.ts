import { AppError } from '@velaros-ai/core/error'

import { ChildDeliveryLimits } from '../contract/constants.js'
import type { ActRunEvent } from '../types/act.js'
import type { AgentJob } from '../types/delegation.js'

/** 引导拒绝带上权威状态和显式续跑入口，不把收束误报成暂时未就绪。 */
export function guidanceUnavailable(job: AgentJob): AppError {
  return new AppError(
    'UNAVAILABLE',
    `子运行当前状态为 ${job.status}，不能接收引导；收束后使用 resume 在同一会话续跑，已用预算保留。`
  )
}

/** 在子任务收集时及时释放超额正文，返回本次移出条数。 */
export function appendChildEvent(events: ActRunEvent[], event: ActRunEvent): number {
  events.push(event)
  let omitted = 0
  while (
    events.length > ChildDeliveryLimits.events ||
    JSON.stringify(events).length > ChildDeliveryLimits.chars
  ) {
    events.shift()
    omitted++
  }
  return omitted
}
