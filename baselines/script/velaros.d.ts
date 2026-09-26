declare module 'velaros' {
  /**
   * 交出结果。只 output 下一轮真正需要的事实：数据在脚本里先筛选、计算、聚合，读到的全部内容不必都交出来。
   */

  export const output: ScriptOutput

  /**
   * 交出一个值给下一轮看：按 JSON 保存，对象里值为 undefined 的字段省略，数组里的空位或 undefined 变成 null，只有交出 undefined 本身会报错；一次执行最多 64 块。
   * configure 要在第一次 output 之前调用。
   */
  interface ScriptOutput {
    (value: unknown, options?: ScriptOutputOptions): void
    configure(config: ScriptOutputConfig): void
  }

  /**
   * 这一块输出的用途与展示：key 是本次执行里唯一的稳定名字（字母或数字开头，只用字母、数字与 _ . -，最多 96 个字符），整理工具凭它调整展示；
   * purpose 说明持续观察它的原因（最多 1000 个字符）；priority 是 high、normal 或 low，只影响预算分配；
   * required 为 true 表示这块原值是做决定必需的，必须带 key，放不下时报告缺口、收尾要等它补齐，只用于少量关键事实。
   */
  interface ScriptOutputOptions {
    readonly key?: string
    readonly purpose?: string
    readonly type?: ScriptOutputType
    /** 代码的语言标签，最多 80 个字符。 */
    readonly language?: string
    readonly priority?: 'high' | 'normal' | 'low'
    readonly required?: boolean
    readonly view?: ScriptOutputView
  }

  /**
   * 整份输出的展示预算：缺省 16000 个字符，包括输出目录与省略说明；交的放不下时每块只露出一部分，结果头里写着这次的 displayChars。
   * 要一次看完整段代码或长文，先 output.configure({maxChars}) 放大（最多 200000，实际分配仍由宿主决定），或者分几次执行各交一部分。
   */
  interface ScriptOutputConfig {
    readonly maxChars?: number
  }

  /**
   * 内容类型：不给时字符串按 text、数组按 list、其余按 json 展示；code 可再配 language。它不改变来源的可信度。
   */
  type ScriptOutputType = 'text' | 'code' | 'json' | 'list' | 'image' | 'file'

  /**
   * 怎么展示（只影响你下一轮看到多少，原值照样完整保存，可以按引用召回）：
   * mode 默认 auto，按展示预算挑内容；full 要求整个值放得下，放不下就只给引用；reference 只给引用；summary 只展示整理服务已生成、版本匹配的摘要，没有就给引用。
   * maxChars 本块最多展示多少字符（最多 200000）；lines 是一基闭区间 [起, 止]；maxItems 列表最多展示几项；edge 从头部或尾部选片段；paths 是 JSON Pointer 数组（最多 64 个），只展示这些字段。
   */
  interface ScriptOutputView {
    readonly mode?: 'auto' | 'full' | 'reference' | 'summary'
    readonly maxChars?: number
    readonly lines?: readonly [number, number]
    readonly maxItems?: number
    readonly edge?: 'head' | 'tail'
    readonly paths?: readonly string[]
  }
}
