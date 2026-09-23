import { ChildDeliveryLimits } from '../contract/constants.js'
import type { ActRunEvent } from '../types/act.js'

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
