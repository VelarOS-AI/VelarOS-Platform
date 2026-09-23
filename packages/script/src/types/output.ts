/**
 * 输出的内容类型；省略时字符串为文本、数组为列表、其余为 JSON。
 * @AgentView
 * 内容类型：不给时字符串按 text、数组按 list、其余按 json 展示；code 可再配 language。它不改变来源的可信度。
 */
export type ScriptOutputType = 'text' | 'code' | 'json' | 'list' | 'image' | 'file'
/**
 * 只影响展示的声明式规则，不能执行函数或改变采集。
 * @AgentView
 * 怎么展示（只影响你下一轮看到多少，原值照样完整保存，可以按引用召回）：
 * mode 默认 auto，按展示预算挑内容；full 要求整个值放得下，放不下就只给引用；reference 只给引用；summary 只展示整理服务已生成、版本匹配的摘要，没有就给引用。
 * maxChars 本块最多展示多少字符（最多 200000）；lines 是一基闭区间 [起, 止]；maxItems 列表最多展示几项；edge 从头部或尾部选片段；paths 是 JSON Pointer 数组（最多 64 个），只展示这些字段。
 */
export interface ScriptOutputView {
  readonly mode?: 'auto' | 'full' | 'reference' | 'summary'
  readonly maxChars?: number
  readonly lines?: readonly [number, number]
  readonly maxItems?: number
  readonly edge?: 'head' | 'tail'
  readonly paths?: readonly string[]
}
/**
 * 模型声明的输出用途与展示方式。
 * @AgentView
 * 这一块输出的用途与展示：key 是本次执行里唯一的稳定名字（字母或数字开头，只用字母、数字与 _ . -，最多 96 个字符），整理工具凭它调整展示；
 * purpose 说明持续观察它的原因（最多 1000 个字符）；priority 是 high、normal 或 low，只影响预算分配；
 * required 为 true 表示这块原值是做决定必需的，必须带 key，放不下时报告缺口并挡住外部写入，只用于少量关键事实。
 */
export interface ScriptOutputOptions {
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
 * 整份输出的文字展示预算，图片仍由模型请求预算管理。
 * @AgentView
 * 整份输出的展示预算：maxChars 包括输出目录与省略说明（最多 200000），实际分配仍由宿主决定。
 */
export interface ScriptOutputConfig {
  readonly maxChars?: number
}
/**
 * `velaros` 里的 output：调用它交出一个值，configure 设整份输出的展示预算。
 * @AgentView
 * 交出一个值给下一轮看：按 JSON 保存，对象里值为 undefined 的字段省略，数组里的空位或 undefined 变成 null，只有交出 undefined 本身会报错；一次执行最多 64 块。
 * configure 要在第一次 output 之前调用。
 */
export interface ScriptOutput {
  (value: unknown, options?: ScriptOutputOptions): void
  configure(config: ScriptOutputConfig): void
}
/** 隔离运行器在 output 调用时捕获的不可变值。 */
export interface ScriptOutputBlock {
  /** 稳定名字或本次执行的自动序号名。 */
  readonly key: string
  /** 原始模型声明。 */
  readonly options: ScriptOutputOptions
  /** 调用时的 JSON 值快照。 */
  readonly value: unknown
  /** 快照 JSON 字符数。 */
  readonly chars: number
}
/** 有界原始输出归档；问题单独保留，不由模型 catch 隐藏。 */
export interface ScriptOutputCapture {
  /** 脚本声明的总预算。 */
  readonly config: ScriptOutputConfig
  /** 已成功捕获的块。 */
  readonly blocks: readonly ScriptOutputBlock[]
  /** 拒绝、溢出等捕获问题。 */
  readonly issues: readonly string[]
}
/** 编译器识别的可管理源码声明。 */
export interface ScriptOutputManifest {
  /** 源码声明的整体预算。 */
  readonly config: ScriptOutputConfig
  /** 直接导入的 output 调用及其静态 options。 */
  readonly outputs: readonly ScriptOutputOptions[]
}
/**
 * 只修改声明式展示数据的源码补丁。
 * @AgentView
 * 展示的调整：config 替换整份输出的展示预算，outputs 按稳定 key 整个替换那一块的 view；其余观察意图保持不变。
 */
export interface ScriptOutputEdit {
  /** 替换整体展示配置；不填表示保持原样。 */
  readonly config?: ScriptOutputConfig
  /** 按稳定键完整替换 view，其余观察意图保持不变。 */
  readonly outputs?: ReadonlyArray<{readonly key:string; readonly view:ScriptOutputView}>
}
/** 摘要严格绑定原始内容和当前任务解释代次。 */
export interface ScriptOutputSummary {
  /** 稳定输出名字。 */
  readonly key: string
  /** 原始值指纹。 */
  readonly contentHash: string
  /** 生成摘要时的任务目标代次。 */
  readonly taskRevision: string
  /** 模型解释正文。 */
  readonly text: string
}
/** 每个块的实际展示状态，正文和原始值分别保存。 */
export interface ScriptOutputPresentation {
  /** 输出身份。 */
  readonly key:string
  /** 内容类型。 */
  readonly type:ScriptOutputType
  /** 观察目的。 */
  readonly purpose?:string
  /** 代码语言标签。 */
  readonly language?:string
  /** 原始值指纹，仅内容相同时相同。 */
  readonly contentHash:string
  /** 完整正文、片段、摘要或引用。 */
  readonly representation:'full'|'excerpt'|'summary'|'reference'
  /** 本轮实际展示的正文。 */
  readonly text:string
  /** 是否实际提供正文。 */
  readonly bodyIncluded:boolean
  /** 原始执行结果引用。 */
  readonly rawRef:string
  /** 原始归档中的 JSON Pointer。 */
  readonly pointer:string
  /** 原始快照字符数。 */
  readonly totalChars:number
  /** 列表原始条数。 */
  readonly totalItems?:number
  /** 实际选择的范围或缺失路径。 */
  readonly selection?:unknown
  /** 降级或缺口说明。 */
  readonly reason?:string
}
/** 输出整理的完整结果；prompt 才是计算预算的实际文字。 */
export interface ScriptOutputProjection {
  /** 块目录，可用于结构化审计。 */
  readonly blocks:readonly ScriptOutputPresentation[]
  /** 实际发送的有界文字。 */
  readonly prompt:string
  /** 源码申请的上限。 */
  readonly requestedChars:number
  /** 宿主实际分配的上限。 */
  readonly allocatedChars:number
  /** 连目录也放不下的块数量。 */
  readonly omittedBlocks:number
  /** 捕获问题始终明确显示。 */
  readonly issues:readonly string[]
}

/** 宿主计量的一次执行成本，不把输出大小误称为外部读取量。 */
export interface ScriptExecutionMetrics {
  /** 端到端执行耗时，包含等待能力返回。 */
  readonly durationMs:number
  /** 实际发起的能力调用数。 */
  readonly capabilityCalls:number
  /** 成功归档输出的 JSON UTF-16 字符数。 */
  readonly rawOutputChars:number
}
