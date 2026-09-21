import type { ActRunEvent } from '../contract/act.js'

/** 子任务交付只携带有界尾部，完整事件仍保存在子会话中。 */
export const ChildDeliveryLimits=Object.freeze({
 /** 交付报告的最大内嵌事件条数。 */
 events:64,
 /** 交付报告的最大事件正文字符数。 */
 chars:128000,
})

/** 在子任务收集时及时释放超额正文，返回本次移出条数。 */
export function appendChildEvent(events:ActRunEvent[],event:ActRunEvent):number{
 events.push(event)
 let omitted=0
 while(events.length>ChildDeliveryLimits.events||JSON.stringify(events).length>ChildDeliveryLimits.chars){events.shift();omitted++}
 return omitted
}
