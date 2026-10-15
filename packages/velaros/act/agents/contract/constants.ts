/** 模块稳定身份。 */
export const AgentsModuleId = 'velaros:agents' as const
/** 模块对外约定的容量。 */
export const AgentsLimits = Object.freeze({
  /** 子任务最多附带的材料引用数。 */
  materials: 32,
  /** 一次等待任一结果的子任务数。 */
  waitTargets: 32,
})

/** 模块稳定身份。 */
export const WidgetModuleId = 'velaros:widget' as const
/** 小部件对外约定的容量；高度超出上下限时按边界算，不报错。 */
export const WidgetLimits = Object.freeze({
  /** 标题最多多少字符。 */
  titleChars: 200,
  /** 一个小部件的代码最多多少字符。 */
  codeChars: 120_000,
  /** 初始高度的下限，像素。 */
  minHeight: 120,
  /** 初始高度的上限，像素。 */
  maxHeight: 900,
  /** 不给高度时的初始高度，像素。 */
  defaultHeight: 400,
})

/** 模块稳定身份。 */
export const InteractionModuleId = 'velaros:interaction' as const
/** 交互请求对外约定的容量。 */
export const InteractionLimits = Object.freeze({
  /** 一次请求的说明最多多少字符。 */
  messageChars: 8000,
  /** 一个问题或一个选择字段最多给几个选项；至少两个。 */
  options: 8,
  /** 一张表单最多几项。 */
  fields: 8,
  /** 选项与字段 id 最多多少字符。 */
  idChars: 64,
  /** 选项与字段的标题最多多少字符。 */
  labelChars: 200,
  /** 选项说明与输入提示最多多少字符。 */
  descriptionChars: 500,
  /** 宿主回答里的文字最多保留多少字符。 */
  answerChars: 8000,
})
