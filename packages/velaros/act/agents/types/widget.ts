/**
 * @AgentView
 * 要显示的小部件：title 是给用户看的标题，1 到 200 个字符；code 是一段 HTML 片段（依次写 style、内容、script，
 * 不写 doctype、html、head、body）或以 <svg 开头的 SVG，1 到 120000 个字符；height 是初始高度，像素，120 到 900，缺省 400。
 * key 是可选的同轮展示键，去除首尾空白后 1 到 64 个字符。修正同一张卡时沿用 key，保留两张时使用不同的 key 或省略 key。
 */
export interface WidgetRequest {
  readonly title: string
  readonly code: string
  readonly height?: number
  readonly key?: string
}

/** 交给宿主显示的小部件：同一轮内按 id 原位更新，高度已经收进上下限。 */
export interface WidgetView {
  readonly id: string
  readonly title: string
  readonly code: string
  readonly height: number
}
