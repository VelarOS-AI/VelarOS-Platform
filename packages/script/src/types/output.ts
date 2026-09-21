/** 输出的内容类型；省略时字符串为文本、数组为列表、其余为 JSON。 */
export type ScriptOutputType = 'text' | 'code' | 'json' | 'list' | 'image' | 'file'
/** 只影响展示的声明式规则，不能执行函数或改变采集。 */
export interface ScriptOutputView {
  /** 默认 auto；full 放不下时明确返回引用，summary 需要匹配原文的已有摘要。 */
  readonly mode?: 'auto' | 'full' | 'reference' | 'summary'
  /** 本块正文最多展示多少 UTF-16 字符。 */
  readonly maxChars?: number
  /** 代码或文本的一基闭区间。 */
  readonly lines?: readonly [number, number]
  /** 列表最多展示的条数。 */
  readonly maxItems?: number
  /** 片段从头部或尾部选择。 */
  readonly edge?: 'head' | 'tail'
  /** JSON Pointer 字段选择，未命中路径显式返回缺口。 */
  readonly paths?: readonly string[]
}
/** 模型声明的输出用途与展示方式。 */
export interface ScriptOutputOptions {
  /** 本次执行唯一的稳定名字。 */
  readonly key?: string
  /** 持续观察的原因，属于模型解释。 */
  readonly purpose?: string
  /** 内容类型，不提升来源可信度。 */
  readonly type?: ScriptOutputType
  /** 代码语言标签。 */
  readonly language?: string
  /** 预算分配优先级，不保证突破宿主窗口。 */
  readonly priority?: 'high' | 'normal' | 'low'
  /** 本块完整原值是决策必需内容；未完整投递时报告缺口并阻止外部写入。 */
  readonly required?: boolean
  /** 可由整理工具修改的纯数据规则。 */
  readonly view?: ScriptOutputView
}
/** 整份输出的文字展示预算，图片仍由模型请求预算管理。 */
export interface ScriptOutputConfig {
  /** 包括输出目录与省略说明，不包括观察源码和其他分区。 */
  readonly maxChars?: number
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
/** 只修改声明式展示数据的源码补丁。 */
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
