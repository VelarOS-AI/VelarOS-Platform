/** 模块稳定身份。 */
export const AgentsModuleId = 'velaros:agents' as const
/** 模块对外约定的容量。 */
export const AgentsLimits = Object.freeze({
  /** 子任务最多附带的材料引用数。 */
  materials: 32,
})

/** 模块稳定身份。 */
export const InteractionModuleId = 'velaros:interaction' as const
/** 交互请求对外约定的容量。 */
export const InteractionLimits = Object.freeze({
  /** 一次请求的说明最多多少字符。 */
  messageChars: 8000,
})
