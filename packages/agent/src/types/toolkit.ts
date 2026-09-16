import type { z } from 'zod'

import type { ScopeRef } from '@velaros-ai/kernel/contracts/abi'

import type { AgentModelInputModality, ToolCapabilitySchema, ToolCategoryId, ToolConfirmationDecisionOptions,ToolExposurePolicy, ToolPermission, ToolRole, ToolSurfaceProfileId } from './agent.js'
import type { ToolCodingSessionApi } from './tool-context.js'

export type NonEmptyToolContractList<T = string> = readonly [T, ...T[]]

/** 工具角色，统一别名到 core types 的 ToolRole（单一事实源，避免重复联合）。 */
export type ToolContractRole = ToolRole

/**
 * 工具的模型面描述。只有摘要与适用场景必填；禁止、强制流程、用法、示例、注意按需写，不写就不渲染那一节。
 * 没有参数的工具不用硬凑用法和示例。
 */
export interface ToolContractDescriptionSpec {
  role: ToolContractRole
  summary: string
  suitable: NonEmptyToolContractList
  forbidden?: NonEmptyToolContractList
  protocol?: NonEmptyToolContractList
  usage?: NonEmptyToolContractList
  examples?: NonEmptyToolContractList<Record<string, unknown>>
  notes?: NonEmptyToolContractList
  /**
   * companion skill 的 id（对应 `skills-market/<id>.md`）——工具是调用面，这个 id 指向用法面。
   *
   * 声明后模型面描述末尾自动追加一条「深度用法先读 skill:<id>」，工具页卡片也透出该字段。
   * 只声明不瘦身没有意义：这条轴存在的全部理由是把工艺深度搬出模型面描述（design-principles §8）。
   * id 是否真有对应技能由产品宿主在构建期检查，因为技能目录不属于此包产物。
   */
  usageSkillId?: string
  /**
   * 软预算（1800 字符）豁免。**不是给「写长了懒得拆」用的**，见 ToolDescriptionBudgetWaiver：
   * 理由只认 safety-protocol / meta-tool，且必须写 note 说明为什么属于该档。
   */
  descriptionBudgetWaiver?: ToolDescriptionBudgetWaiver
}

export interface ToolContractSurface<
  TSurfaceInput extends Record<string, unknown> = Record<string, unknown>,
  TBaseInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
> {
  description: string
  schema: z.ZodType<TSurfaceInput>
  normalize?: (input: TSurfaceInput, ctx: TContext) => TBaseInput
}

export type ToolContractExecute<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
  TResult = unknown,
> = (input: TInput, ctx: TContext) => Promise<TResult>

/** Runtime-only provenance from a settled saved attempt; never accepted from model input. */
export interface ToolInputReuseMigrationRequest {
  input: Record<string, unknown>
  sourceContractVersion: number
  targetContractVersion: number
  sourceToolName: string
  sourceCallId: string
  toolCallId?: string
}

export interface ToolInputReuseContract<TContext = unknown> {
  /** Omitted versions are the original input contract, version 1. */
  inputContractVersion?: number
  /** Trusted compatibility sources for renamed or split tools. */
  inputReuseSourceTools?: readonly string[]
  /** Runs only for verified, unapplied saved input whose tool or contract changed. */
  migrateReusedInput?: (
    request: ToolInputReuseMigrationRequest,
    context: TContext
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
}

export interface ToolContractRuntimeSpec<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
  TResult = unknown,
  TPermission extends string = ToolPermission,
> extends ToolInputReuseContract<TContext> {
  /** 模型可调用的唯一规范工具名。 */
  name: string
  /** 工具所属能力分类。 */
  category: ToolCategoryId
  /** 工具角色，决定读改分离与执行策略。 */
  role: ToolContractRole
  /** 目录与 Mod 声明使用的短说明；结构化长描述仍由 description 承载。 */
  summary?: string
  /**
   * 跨宿主只读分类。defineToolRuntimeSpec 会从 capabilities.effectKind 派生；
   * 没有 capability 元数据时采用显式值或回退 role=inspect。手工构造的外部工具可省略。
   */
  readOnly?: boolean
  description: string
  /** 见 ToolContractDescriptionSpec.usageSkillId：companion skill 的 id，透到工具页卡片。 */
  usageSkillId?: string
  schema: z.ZodType<TInput>
  surfaces?: Partial<Record<ToolSurfaceProfileId, ToolContractSurface<any, TInput, TContext>>>
  permissions: TPermission[]
  capabilities?: ToolCapabilitySchema
  /** Model input kinds required to consume this tool's result (for example, screenshots need image). */
  requiredModelInputModalities?: readonly AgentModelInputModality[]
  exposure?: ToolExposurePolicy
  /**
   * 工具输出是否必须**保持内联**、禁止被 page-out 成 payload 引用（__kernelRef）。
   * 用于发现/索引/目录类工具（如 tooling:map）——它们的输出就是模型当下要读的内容，
   * 被卸载后模型还得 context:recall 召回，自我抵消。声明在工具上、单一来源、易维护。
   */
  outputInline?: boolean
  /** 运行依赖不存在时不进入工具发现目录。 */
  hideWhenUnavailable?: boolean
  isAvailable?: (ctx: TContext) => boolean
  /**
   * `isAvailable` 为假时给发现层（`tooling:map` 页表）的**具体原因**。
   *
   * 判据：`hideWhenUnavailable: false` 的意思是「留在发现层让模型看见」，而页表原来只有一句
   * 泛化的「工具注册存在，但当前运行态不可用。」——模型据此只会判定「此路不通」，然后去搜别的
   * 工具或退回手搓，与整族隐身的结局相同。留在发现层要成立，就必须同时给出**为什么不可用、
   * 谁来解除**。返回 null = 没有比泛化文案更具体的可说的。
   *
   * 注意分工：模型自己能解除的前置**不该**走这里（那种前置根本不该进 `isAvailable`，应当在
   * 执行期回可执行错误）；这里说的是「需要用户动手」那一档，如没绑工程根、插件没装。
   */
  unavailableReason?: (ctx: TContext) => Nullable<string>
  isConcurrencySafe?: (input: TInput) => boolean
  execute: ToolContractExecute<TInput, TContext, TResult>
}

export interface DefineToolContractSurfaceInput<
  TSurfaceInput extends Record<string, unknown> = Record<string, unknown>,
  TBaseInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
> extends ToolContractDescriptionSpec {
  schema: z.ZodType<TSurfaceInput>
  normalize?: (input: TSurfaceInput, ctx: TContext) => TBaseInput
}

export interface DefineToolRuntimeSpecInput<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
  TResult = unknown,
  TPermission extends string = ToolPermission,
> extends ToolContractDescriptionSpec, ToolInputReuseContract<TContext> {
  name: string
  category: ToolCategoryId
  schema: z.ZodType<TInput>
  surfaces?: Partial<
    Record<ToolSurfaceProfileId, DefineToolContractSurfaceInput<any, TInput, TContext>>
  >
  permissions: TPermission[]
  capabilities?: ToolCapabilitySchema
  requiredModelInputModalities?: readonly AgentModelInputModality[]
  exposure?: ToolExposurePolicy
  /** 见 ToolContractRuntimeSpec.outputInline：输出禁止 page-out，始终内联。 */
  outputInline?: boolean
  hideWhenUnavailable?: boolean
  isAvailable?: (ctx: TContext) => boolean
  /** 见 ToolContractRuntimeSpec.unavailableReason：不可用时给发现层的具体原因。 */
  unavailableReason?: (ctx: TContext) => Nullable<string>
  isConcurrencySafe?: (input: TInput) => boolean
  execute: ToolContractExecute<TInput, TContext, TResult>
}

export interface DefineToolContractInput<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
> extends ToolContractDescriptionSpec, ToolInputReuseContract<TContext> {
  name: string
  category: ToolCategoryId
  schema: z.ZodType<TInput>
  executeSchema?: z.ZodType<TInput>
  surfaces?: Partial<Record<ToolSurfaceProfileId, ToolContractSurface<any, TInput, TContext>>>
  permissions?: ToolPermission[]
  capabilities?: ToolCapabilitySchema
  requiredModelInputModalities?: readonly AgentModelInputModality[]
  exposure?: ToolExposurePolicy
  hideWhenUnavailable?: boolean
  isAvailable?: (ctx: TContext) => boolean
  /** 见 ToolContractRuntimeSpec.unavailableReason：不可用时给发现层的具体原因。 */
  unavailableReason?: (ctx: TContext) => Nullable<string>
  isConcurrencySafe?: (input: TInput) => boolean
  execute: (input: TInput, ctx: TContext) => Promise<unknown> | unknown
}

export interface ToolContractSpec<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
> extends Omit<
  DefineToolContractInput<TInput, TContext>,
  'summary' | 'suitable' | 'forbidden' | 'protocol' | 'usage' | 'examples' | 'notes'
> {
  descriptionSpec: ToolContractDescriptionSpec
  description: string
  examples?: NonEmptyToolContractList<Record<string, unknown>>
}

export type ManualApprovalOptions = Omit<
  ToolConfirmationDecisionOptions,
  'requireManualApproval' | 'rememberRiskScope'
>

/**
 * 无人值守审批升级的生命周期钩子：升级挂起 / 升级返回。
 *
 * 供宿主把「子 Agent 正等父线程裁决高风险操作」投影成 UI 状态（如 worker 线程状态卡）；
 * 端口本体不承载任何宿主文案，钩子只回传原始 message，格式化归宿主。
 */
export interface UnattendedApprovalEscalationHooks {
  onEscalationPending?: (message: string) => void
  onEscalationResolved?: () => void
}

/** 铁律⑧:系统替模型做过的调整(钳制/缺省/别名采用)统一回显形状。 */
export interface AppliedAdjustment {
  field: string
  action: 'clamped' | 'defaulted' | 'aliased' | 'ignored' | 'coerced' | 'normalized'
  detail: string
}

export type ToolConceptRegistry = Record<string, string>

export interface ToolReadOnlyClassification {
  readOnly?: boolean
  role?: string
  capabilities?: { effectKind?: string }
}

/** 内核按名调用一个工具之前，按作用域给出这次调用的工具上下文；上下文里的 abortSignal 会被换成内核给的那个。 */
export type ToolContextResolver<TContext> = (
  scope: LooseOptional<ScopeRef>,
  signal: AbortSignal,
) => TContext | Promise<TContext>

/** 把工具集合包装成内核可调用操作表时的选项。 */
export interface ToolCallableOperationsOptions {
  /** 报错与缺省理由里称呼这组能力的中文名，比如「系统」「项目」「办公」。 */
  label: string
  /** 工具抛出的领域错误怎么翻成对外的错误；不给就原样抛出。 */
  mapError?: (error: unknown) => unknown
}

/** 能包装成内核操作的工具要有的那几样：名字、入参 schema、权限、能力声明里的理由、可用性判断和 execute。 */
export interface CallableToolSpec<TContext> {
  name?: string
  schema: z.ZodType
  permissions: readonly string[]
  capabilities?: { reason?: string }
  isAvailable?: (context: TContext) => boolean
  execute: (input: Record<string, unknown>, context: TContext) => unknown
}

export interface ToolSchemaSource {
  name: string
  description: string
  schema: z.ZodType
}

export interface ToolSchemaBundle {
  schemaVersion: 1
  $defs: Record<string, unknown>
  tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }>
}

export interface CreateToolSchemaBundleOptions {
  schemaVersion?: 1
  sharedSchemaId?: string
  sharedSchemaExternalUri?: string
  maxInlineSharedDefChars?: number
}

export interface SchemaBundleContext {
  sharedSchemaRefPrefix: string
  bundleSharedSchemaRefPrefix: string
  inlineSharedDefMaxChars: number
}

export type NonEmptyDescriptionItems = readonly [string, ...string[]]

export interface StructuredToolDescriptionSpec {
  description: string
  suitable: NonEmptyDescriptionItems
  forbidden?: NonEmptyDescriptionItems
  protocol?: NonEmptyDescriptionItems
  usage?: NonEmptyDescriptionItems
  examples?: NonEmptyDescriptionItems
  notes?: NonEmptyDescriptionItems
}

export interface StructuredToolDescriptionParts {
  description: string
  suitable: string[]
  forbidden: string[]
  protocol: string[]
  usage: string[]
  examples: string[]
  notes: string[]
}

export interface StructuredParameterDescriptionSpec {
  description: string
  values?: NonEmptyDescriptionItems
  usage?: NonEmptyDescriptionItems
  notes?: NonEmptyDescriptionItems
}

export interface ToolDescriptionLike {
  description: string
}

/** 软预算豁免理由；只有这两种，别加第三种（加之前先改 §8 判决）。 */
export type ToolDescriptionBudgetWaiverReason =
  /** 强制流程本身就是防损坏的安全约束，拆进技能等于拆护栏（技能可能没装、可能没被读）。 */
  | 'safety-protocol'
  /** `tooling:*` 这类自举工具——模型靠它才找得到技能，没有「先读技能」的余地。 */
  | 'meta-tool'

export interface ToolDescriptionBudgetWaiver {
  reason: ToolDescriptionBudgetWaiverReason
  /** 为什么这个工具属于该档；必填，空白视同没写。写给下一个想砍它的人看。 */
  note: string
}

/**
 * 结构化描述的语法（分节顺序 / 允许分节 / 必需分节）。
 *
 * 工具描述与参数描述用同一部语法、只换这三张表；此前两份校验各写一遍 28 行，
 * 语法改一处必漏另一处，故收成单一校验器 + 两张语法表。
 */
export interface StructuredDescriptionGrammar {
  sectionOrder: ReadonlyMap<string, number>
  allowedSections: ReadonlyArray<ReadonlySet<string>>
  requiredSections: ReadonlySet<string>
}

/**
 * 工具描述详细程度（渐进式披露 / progressive disclosure）。
 * - full：保留作者写下的全部条目。
 * - compact：保留结构与每个分节的首条要点，作为 tier-1 精简描述，降低 token 成本。
 */
export type ToolDescriptionDetail = 'full' | 'compact'

export type ApprovalSession = Pick<ToolCodingSessionApi,
  'recordConfirmationCard' | 'recordTaskApproval' | 'getTaskApprovalDenial' |
  'hasConfirmedRiskScope' | 'grantConfirmedRiskScope'>

/** 带上界的文件读取输入。 */
export interface BoundedReadInput {
  /** 可选起始行。 */
  startLine?: number
  /** 读取结束行。 */
  endLine?: number
  /** 读取字符上限。 */
  maxChars?: number
}

/** 递归目录遍历输入。 */
export interface RecursiveTraversalInput {
  /** 是否递归进入子目录。 */
  recursive?: boolean
  /** 递归最大深度。 */
  maxDepth?: number
}

export type JsonSchemaObject = Record<string, unknown>
