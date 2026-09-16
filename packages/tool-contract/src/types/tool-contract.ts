/**
 * 可移植数据：一条工具对外声明的那些形状——身份、类别、角色、权限、能力声明、暴露策略、
 * 结构化说明、入参上界、失败回执的回显。不 import 任何东西，浏览器与渲染进程都能加载
 * （从 `@velaros-ai/tool-contract/contracts` 取）。
 *
 * 这里的工具协议类型与 `@velaros-ai/agent/protocol` 里同名的那几个是同形副本：agent 的可移植
 * 数据文件按标准不许 import，两边只能各持一份，由仓库级一致性测试 `tests/tool-contract/` 守着。
 */

/** 能力包或宿主登记的权限 id，本包不解释它的含义。 */
export type ToolPermission = string

/** 能力包登记的工具类别 id，本包不解释它的含义。 */
export type ToolCategoryId = string

/** 工具角色：刻画工具对外部世界的作用面，用于读改分离与子 Agent 暴露收窄。 */
export type ToolContractRole = string

/** 工具面档位 id：同一个工具在不同档位下可以有各自的入参与说明。 */
export type ToolSurfaceProfileId = string

/** 运行模式 id：工具暴露策略按模式给各自的常驻与排序覆盖。 */
export type ToolExposureProfileId = 'compact' | 'balanced' | 'expanded'

/** 模型输入形态：工具回执要被模型读懂时，模型必须先支持这几种输入之一。 */
export type ToolModelInputModality = 'text' | 'image' | 'audio'

/** 跨域的副作用词汇，由 Agent、审批宿主与评测方共同解释；域内的访问语义写进能力声明的别的格。 */
export type ToolCapabilityEffectKind =
  | 'read'
  | 'write'
  | 'execute'
  | 'external'
  | 'destructive'

/** 能力包自己登记的信息域 id（工具读或写的是哪一类信息）。 */
export type ToolCapabilitySourceScope = string

/** 能力包自己登记的文件系统边界 id。 */
export type ToolCapabilityFilesystemScope = string

/** 同一工具能不能并发跑：安全、不安全，或者要看这次的入参。 */
export type ToolCapabilityConcurrency = 'safe' | 'unsafe' | 'input-dependent'

/** 工具的事务身份：哪些入参字段承载事务 id，带 scope 的校验算不算落盘前校验。 */
export interface ToolCapabilityTransactionSchema {
  /** 参数里承载 transaction id 的字段名；用于动态判断是否声明了事务 scope。 */
  scopeFields?: readonly string[]
  /** scoped validate 是否视为 apply 前校验。 */
  preApplyValidationWhenScoped?: boolean
}

/** 一条工具的能力声明：它有什么副作用、读写哪些域、能不能并发、为什么要这个权限。 */
export interface ToolCapabilitySchema {
  /** 工具的主要副作用类别。 */
  effectKind: ToolCapabilityEffectKind
  /** 工具可能读取的信息域。 */
  readScopes?: readonly ToolCapabilitySourceScope[]
  /** 工具可能写入或控制的信息域。 */
  writeScopes?: readonly ToolCapabilitySourceScope[]
  /** 文件系统读写边界；any 只应用于显式系统文件读写能力。 */
  filesystem?: {
    read?: ToolCapabilityFilesystemScope
    write?: ToolCapabilityFilesystemScope
  }
  /** 能力自己定义的事务身份字段。 */
  transaction?: ToolCapabilityTransactionSchema
  /** 进程执行形态。 */
  process?: {
    execution?: 'none' | 'short' | 'long-running' | 'dangerous' | 'input-dependent'
  }
  /** 同一工具能不能并发跑。 */
  concurrency?: ToolCapabilityConcurrency
  /** 工具是否可能读到任意来源的内容（据此判断提示注入面）。 */
  canReadArbitrarySource?: boolean
  /** 为什么要这些权限：进内核调用元数据，出现在审批与审计里。 */
  reason?: string
  /** 能力自己持有、内核从不解释的数据。 */
  metadata?: Readonly<Record<string, unknown>>
}

/** 工具的使用频率与稳定性分层：运行模式的工具页预算优先保留更高层级。 */
export type ToolExposureTier =
  | 'essential'
  | 'common'
  | 'situational'
  | 'specialized'
  | 'experimental'

/** 某个运行模式下对一条工具的暴露覆盖。 */
export interface ToolExposureProfilePolicy {
  /** 历史「直接暴露」标记，仅作兼容保留，当前不被准入逻辑读取。 */
  expose?: boolean
  /** 在该模式下预驻留到模型外层工具空间，不参与普通工具页裁剪。 */
  alwaysResident?: boolean
  /** 在该模式下调整排序；负数更靠前，正数更靠后。 */
  rankBoost?: number
}

/** 一条工具的暴露策略：分层、排序、是否常驻，以及按运行模式的覆盖。 */
export interface ToolExposurePolicy {
  /** 粗粒度使用频率/稳定性分层；运行模式预算优先保留更高层级。 */
  tier?: ToolExposureTier
  /** 同 tier 内的稳定排序；数字越小越优先。 */
  rank?: number
  /** 已授权时始终直接暴露完整 schema，不参与普通工具页裁剪。 */
  alwaysResident?: boolean
  /** 针对某个运行模式的直接暴露/排序覆盖。 */
  profiles?: Partial<Record<ToolExposureProfileId, ToolExposureProfilePolicy>>
}

/** 至少有一项的只读列表；工具说明的每个分节都用它，空分节写不出来。 */
export type NonEmptyToolContractList<T = string> = readonly [T, ...T[]]

/** 结构化说明里一个分节的条目，至少一条。 */
export type NonEmptyDescriptionItems = readonly [string, ...string[]]

/** 软预算豁免理由；只有这两种，别加第三种。 */
export type ToolDescriptionBudgetWaiverReason =
  /** 强制流程本身就是防损坏的安全约束，拆进技能等于拆护栏（技能可能没装、可能没被读）。 */
  | 'safety-protocol'
  /** `tooling:*` 这类自举工具——模型靠它才找得到技能，没有「先读技能」的余地。 */
  | 'meta-tool'

/** 工具说明软预算的豁免声明：理由加一句「凭什么算这一类」。 */
export interface ToolDescriptionBudgetWaiver {
  /** 豁免理由；只认 safety-protocol 与 meta-tool 两种。 */
  reason: ToolDescriptionBudgetWaiverReason
  /** 为什么这个工具属于该档；必填，空白视同没写。写给下一个想砍它的人看。 */
  note: string
}

/**
 * 工具的模型面描述。只有摘要与适用场景必填；禁止、强制流程、用法、示例、注意按需写，不写就不渲染那一节。
 * 没有参数的工具不用硬凑用法和示例。
 */
export interface ToolContractDescriptionSpec {
  /** 工具角色，决定读改分离与执行策略。 */
  role: ToolContractRole
  /** 一句话摘要，渲染成「描述：」那一段。 */
  summary: string
  /** 适合用它的场景，至少一条。 */
  suitable: NonEmptyToolContractList
  /** 禁止用它的场景。 */
  forbidden?: NonEmptyToolContractList
  /** 必须照做的流程门禁。 */
  protocol?: NonEmptyToolContractList
  /** 怎么用它。 */
  usage?: NonEmptyToolContractList
  /** 可以直接照抄的入参示例；每条都会按工具自己的 schema 校验。 */
  examples?: NonEmptyToolContractList<Record<string, unknown>>
  /** 示例讲不出来的注意事项。 */
  notes?: NonEmptyToolContractList
  /**
   * companion skill 的 id（对应 `skills-market/<id>.md`）——工具是调用面，这个 id 指向用法面。
   *
   * 声明后模型面描述末尾自动追加一条「深度用法先读 skill:<id>」，工具页卡片也透出该字段。
   * 只声明不瘦身没有意义：这条轴存在的全部理由是把工艺深度搬出模型面描述。
   * id 是否真有对应技能由产品宿主在构建期检查，因为技能目录不属于此包产物。
   */
  usageSkillId?: string
  /**
   * 软预算豁免。**不是给「写长了懒得拆」用的**，见 ToolDescriptionBudgetWaiver：
   * 理由只认 safety-protocol / meta-tool，且必须写 note 说明为什么属于该档。
   */
  descriptionBudgetWaiver?: ToolDescriptionBudgetWaiver
}

/** 渲染结构化工具说明时要填的七节。 */
export interface StructuredToolDescriptionSpec {
  /** 「描述：」那一段的正文，会被压成单行。 */
  description: string
  /** 「适合：」分节的条目，至少一条。 */
  suitable: NonEmptyDescriptionItems
  /** 「禁止：」分节的条目。 */
  forbidden?: NonEmptyDescriptionItems
  /** 「强制流程：」分节的条目。 */
  protocol?: NonEmptyDescriptionItems
  /** 「用法：」分节的条目。 */
  usage?: NonEmptyDescriptionItems
  /** 「示例：」分节的条目。 */
  examples?: NonEmptyDescriptionItems
  /** 「注意：」分节的条目。 */
  notes?: NonEmptyDescriptionItems
}

/** 把一段已渲染的工具说明解析回来的结果：七节都有值，没写的节是空数组。 */
export interface StructuredToolDescriptionParts {
  /** 「描述：」那一段的正文。 */
  description: string
  /** 「适合：」分节的条目。 */
  suitable: string[]
  /** 「禁止：」分节的条目。 */
  forbidden: string[]
  /** 「强制流程：」分节的条目。 */
  protocol: string[]
  /** 「用法：」分节的条目。 */
  usage: string[]
  /** 「示例：」分节的条目。 */
  examples: string[]
  /** 「注意：」分节的条目。 */
  notes: string[]
}

/** 渲染单个参数说明时要填的四节；语法比工具说明窄。 */
export interface StructuredParameterDescriptionSpec {
  /** 「描述：」那一段的正文，会被压成单行。 */
  description: string
  /** 「取值：」分节的条目：合法取值与边界。 */
  values?: NonEmptyDescriptionItems
  /** 「用法：」分节的条目。 */
  usage?: NonEmptyDescriptionItems
  /** 「注意：」分节的条目。 */
  notes?: NonEmptyDescriptionItems
}

/** 校验整类工具说明时只要求有 description 这一格。 */
export interface ToolDescriptionLike {
  /** 模型看到的那段说明。 */
  description: string
}

/** 判定一条工具算不算只读时看的那三格。 */
export interface ToolReadOnlyClassification {
  /** 显式声明的只读标记。 */
  readOnly?: boolean
  /** 工具角色，最后的兜底判据。 */
  role?: string
  /** 能力声明；有 effectKind 时以它为准。 */
  capabilities?: { effectKind?: string }
}

/** 工具概念表：概念 id → 写给模型看的中文约束句。 */
export type ToolConceptRegistry = Record<string, string>

/** 系统替模型做过的调整（钳制、补缺省、别名采用）统一的回显形状。 */
export interface AppliedAdjustment {
  /** 被调整的字段名。 */
  field: string
  /** 做了哪种调整。 */
  action: 'clamped' | 'defaulted' | 'aliased' | 'ignored' | 'coerced' | 'normalized'
  /** 一句话说明调整前后是什么。 */
  detail: string
}

/** 一次发给模型的工具 schema 包：共享定义提到 `$defs`，每个工具只留自己的入参结构。 */
export interface ToolSchemaBundle {
  /** 包格式版本，当前只有 1。 */
  schemaVersion: 1
  /** 被多个工具共用、提取出来的共享定义。 */
  $defs: Record<string, unknown>
  /** 逐个工具的名字、说明与入参结构。 */
  tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }>
}

/** 造一份工具 schema 包时的选项。 */
export interface CreateToolSchemaBundleOptions {
  /** 包格式版本，当前只有 1。 */
  schemaVersion?: 1
  /** 共享定义在包里的 id 前缀。 */
  sharedSchemaId?: string
  /** 共享定义放在包外时的外部 URI。 */
  sharedSchemaExternalUri?: string
  /** 共享定义短于多少字符就直接内联，不单独建 $defs。 */
  maxInlineSharedDefChars?: number
}

/** 从一次已经结算的失败调用里恢复入参时，运行时给出的来源信息；永远不接受模型直接填。 */
export interface ToolInputReuseMigrationRequest {
  /** 已保存的那份入参。 */
  input: Record<string, unknown>
  /** 那份入参当初用的参数契约版本。 */
  sourceContractVersion: number
  /** 本工具当前的参数契约版本。 */
  targetContractVersion: number
  /** 那次调用的工具名。 */
  sourceToolName: string
  /** 那次调用的 id。 */
  sourceCallId: string
  /** 本次调用的 id。 */
  toolCallId?: string
}

/** 造一条工具失败回执时可以补的两件事：改动有没有落地、落地了哪些。 */
export interface ToolFailureOptions {
  /** 这次失败一个字节都没写，入参可以原样复用后重发。 */
  notApplied?: boolean
  /** 做到一半才失败时，已经落地的那部分（路径、id 之类），按 `ToolContractLimits.failure.listItems` 截断。 */
  applied?: readonly string[]
}
