/**
 * 输出的内容类型；省略时字符串为文本、数组为列表、其余为 JSON。
 * @AgentView
 * 内容类型：不给时字符串按 text、数组按 list、其余按 json 展示；code 可再配 language。它不改变来源的可信度。
 */
export type ScriptOutputType = 'text' | 'code' | 'json' | 'list' | 'image' | 'file'
/**
 * 只影响展示的声明式规则，不能执行函数或改变采集。
 * @AgentView
 * 怎么展示（只影响你下一轮看到多少；原值在采集上限内完整保存，可以按引用召回）：
 * mode 默认 auto，按展示预算挑内容；full 要求整个值放得下，放不下就只给引用；reference 只给引用；summary 只展示整理服务已生成、版本匹配的摘要，没有就给引用。
 * maxChars 本块最多展示多少字符（最多 200000）；未 configure 整体预算时，显式正数也申请本块所需的有限展示份额，实际仍受宿主总预算限制，不保证全文。reference/summary 不扩大整体申请；lines 是一基闭区间 [起, 止]；maxItems 列表最多展示几项；edge 从头部或尾部选片段；paths 是 JSON Pointer 数组（最多 64 个），只展示这些字段。
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
 * required 为 true 表示这块原值是做决定必需的，必须带 key，放不下时报告缺口、收尾要等它补齐，只用于少量关键事实。
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
 * 整份输出的展示预算：maxChars 包括输出目录与省略说明（最多 200000），实际分配由宿主决定；交的放不下时每块只露出一部分，
 * 显式配置优先于各块 view.maxChars 的申请，0 表示不展示；未配置且没有块申请时使用默认预算。结果头里写着这次实际给的 displayChars。要看的内容多（几个大文件、长文），就分几次执行各交一部分。
 */
export interface ScriptOutputConfig {
  readonly maxChars?: number
}
/**
 * `velaros` 里的 output：调用它交出一个值，configure 设整份输出的展示预算。
 * @AgentView
 * 交出一个值给下一轮看：按 JSON 保存，对象里值为 undefined 的字段省略，数组里的空位或 undefined 变成 null，只有交出 undefined 本身会报错；一次执行最多 64 块。
 * 原始 JSON 输出合计最多 1000000 个字符；超限块拒绝采集，不会截断后保存为完整原值。
 * type 为 text 或 code 时值必须是字符串，list 必须是数组；对象或混合结果省略 type，或用 json。静态可确定的类型矛盾在执行前拒绝，动态未知值在 output 调用时校验。
 * view 与 configure 只控制展示，不减少原始采集量；调用 output 前由脚本筛选、聚合，或分页分次执行，避免交出超限原值。
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
  readonly outputs?: ReadonlyArray<{ readonly key: string; readonly view: ScriptOutputView }>
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
  readonly key: string
  /** 内容类型。 */
  readonly type: ScriptOutputType
  /** 观察目的。 */
  readonly purpose?: string
  /** 代码语言标签。 */
  readonly language?: string
  /** 原始值指纹，仅内容相同时相同。 */
  readonly contentHash: string
  /** 完整正文、片段、摘要或引用。 */
  readonly representation: 'full' | 'excerpt' | 'summary' | 'reference'
  /** 本轮实际展示的正文。 */
  readonly text: string
  /** 是否实际提供正文。 */
  readonly bodyIncluded: boolean
  /** 原始执行结果引用。 */
  readonly rawRef: string
  /** 原始归档中的 JSON Pointer。 */
  readonly pointer: string
  /** 原始快照字符数。 */
  readonly totalChars: number
  /** 列表原始条数。 */
  readonly totalItems?: number
  /** 实际选择的范围或缺失路径。 */
  readonly selection?: unknown
  /** 降级或缺口说明。 */
  readonly reason?: string
}
/** 宿主选择的展示编码；JSON 保持结构化兼容，text 按实际编码预算展开各类型块正文。 */
export type ScriptOutputFormat = 'json' | 'text'

/** 受信宿主提供的完整等价文字编码；绑定原块，不改变归档、类型或内容指纹。 */
export interface ScriptOutputDisplay {
  readonly key: string
  readonly contentHash: string
  /** 完整值的等价表示；宿主负责校验来源与无损性，Script 只计量并原样交付。 */
  readonly text: string
}

/** 输出整理的完整结果；prompt 按 format 编码，其 UTF-16 长度就是展示预算计量。 */
export interface ScriptOutputProjection {
  /** prompt 的明确编码，宿主直接发送该文字，不再另行展开。 */
  readonly format: ScriptOutputFormat
  /** 块目录，可用于结构化审计。 */
  readonly blocks: readonly ScriptOutputPresentation[]
  /** 实际发送的有界文字。 */
  readonly prompt: string
  /** 源码申请的上限。 */
  readonly requestedChars: number
  /** 宿主实际分配的上限。 */
  readonly allocatedChars: number
  /** 连目录也放不下的块数量。 */
  readonly omittedBlocks: number
  /** 捕获问题始终明确显示。 */
  readonly issues: readonly string[]
}

/** 宿主计量的一次执行成本，不把输出大小误称为外部读取量。 */
export interface ScriptExecutionMetrics {
  /** 端到端执行耗时，包含等待能力返回。 */
  readonly durationMs: number
  /** 实际发起的能力调用数。 */
  readonly capabilityCalls: number
  /** 成功归档输出的 JSON UTF-16 字符数。 */
  readonly rawOutputChars: number
}
