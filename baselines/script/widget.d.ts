declare module 'velaros:widget' {
  /**
   * 在对话里给用户显示小部件：图表、示意图、可交互的小工具。用户在界面上直接看到它，小部件里调用 sendPrompt(text)
   * 会替用户发一句话过来。代码在沙箱里跑：颜色、字体跟随界面主题，用 CSS 变量写（如 var(--color-text-primary)、
   * var(--color-background-secondary)、var(--color-border-tertiary)、var(--font-sans)）；外部脚本只能从 cdnjs、jsdelivr、
   * unpkg、esm.sh 加载，不能访问网络接口。
   */

  /** 显示一个小部件，立即返回，不等用户操作。
   */
  export function show(input: WidgetRequest): Promise<null>

  /**
   * 要显示的小部件：title 是给用户看的标题，1 到 200 个字符；code 是一段 HTML 片段（依次写 style、内容、script，
   * 不写 doctype、html、head、body）或以 <svg 开头的 SVG，1 到 120000 个字符；height 是初始高度，像素，120 到 900，缺省 400。
   */
  interface WidgetRequest {
    readonly title: string
    readonly code: string
    readonly height?: number
  }
}
