/** 协作声明与提示有界，只用于协调，不参与授权或排他调度。 */
export const AgentCollaborationLimits = Object.freeze({
  /** 单个声明最多包含的写路径前缀数。 */
  paths: 32,
  /** 根路径和每个相对路径的最大字符数。 */
  chars: 1024,
  /** 单次启动或续跑返回的最多重叠提示数。 */
  conflicts: 64,
})

/** 子任务交付只携带有界尾部，完整事件仍保存在子会话中。 */
export const ChildDeliveryLimits = Object.freeze({
  /** 交付报告的最大内嵌事件条数。 */
  events: 64,
  /** 交付报告的最大事件正文字符数。 */
  chars: 128000,
})
