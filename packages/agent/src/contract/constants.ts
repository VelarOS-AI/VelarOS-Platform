/** 子任务交付只携带有界尾部，完整事件仍保存在子会话中。 */
export const ChildDeliveryLimits=Object.freeze({
 /** 交付报告的最大内嵌事件条数。 */
 events:64,
 /** 交付报告的最大事件正文字符数。 */
 chars:128000,
})
