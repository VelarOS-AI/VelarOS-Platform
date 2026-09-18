/**
 * 工具契约的形状：定义一条工具要填什么、定义出来的运行期规格长什么样、模型面说明怎么分节、
 * schema 包长什么样、挂进内核时要给什么，以及审批与有界读那几样。它们引了 zod 与内核的 ABI，所以不进可移植文件；
 * 工具协议的基础词汇（权限、类别、角色、能力声明、暴露策略）在可移植文件 `agent.ts` 里，这里直接引用，不另立副本。
 */

import type { z } from 'zod'

import type {
  CapabilityToken,
} from '@velaros-ai/kernel/contracts'

import type { ToolContextResolver } from '../contract/requires.js'

import type {
  AgentModelInputModality,
  ToolCapabilitySchema,
  ToolCategoryId,
  ToolConfirmationDecisionOptions,
  ToolExposurePolicy,
  ToolPermission,
  ToolRole,
  ToolSurfaceProfileId,
} from './agent.js'
import type { ToolCodingSessionApi } from './tool-context.js'

// ── 模型面说明：分节语法与说明规格 ────────────────────────────────

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
  role: ToolRole
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

/**
 * 结构化说明的语法（分节顺序 / 允许分节 / 必需分节）。
 *
 * 工具说明与参数说明用同一部语法、只换这三张表；此前两份校验各写一遍，
 * 语法改一处必漏另一处，故收成单一校验器 + 两张语法表。
 */
export interface StructuredDescriptionGrammar {
  sectionOrder: ReadonlyMap<string, number>
  allowedSections: ReadonlyArray<ReadonlySet<string>>
  requiredSections: ReadonlySet<string>
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

/** 系统替模型做过的调整（钳制、补缺省、别名采用）统一的回显形状。 */
export interface AppliedAdjustment {
  /** 被调整的字段名。 */
  field: string
  /** 做了哪种调整。 */
  action: 'clamped' | 'defaulted' | 'aliased' | 'ignored' | 'coerced' | 'normalized'
  /** 一句话说明调整前后是什么。 */
  detail: string
}

// ── 定义一条工具：输入与定义出来的运行期规格 ─────────────────────

/** 一条工具在某个工具面档位下的入参与说明；normalize 把档位入参折回基础入参。 */
export interface ToolContractSurface<
  TSurfaceInput extends Record<string, unknown> = Record<string, unknown>,
  TBaseInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
> {
  description: string
  schema: z.ZodType<TSurfaceInput>
  normalize?: (input: TSurfaceInput, ctx: TContext) => TBaseInput
}

/** 一条工具真正干活的那个函数。 */
export type ToolContractExecute<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
  TResult = unknown,
> = (input: TInput, ctx: TContext) => Promise<TResult>

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

/** 失败后入参可复用的工具要声明的三件事：契约版本、可信来源工具、跨版本迁移。 */
export interface ToolInputReuseContract<TContext = unknown> {
  /** 不写就是第 1 版原始入参契约。 */
  inputContractVersion?: number
  /** 改过名或拆分过的工具，列出可信的来源工具名。 */
  inputReuseSourceTools?: readonly string[]
  /** 只对「已证实未生效、且工具或契约变过」的已保存入参运行。 */
  migrateReusedInput?: (
    request: ToolInputReuseMigrationRequest,
    context: TContext
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
}

/** 一条工具的运行期规格：模型看到的那份说明、入参 schema、权限、能力声明与 execute。 */
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
  role: ToolRole
  /** 目录与 Mod 声明使用的短说明；结构化长描述仍由 description 承载。 */
  summary?: string
  /**
   * 跨宿主只读分类。定义工具时会从 capabilities.effectKind 派生；
   * 没有 capability 元数据时采用显式值或回退 role=inspect。手工构造的外部工具可省略。
   */
  readOnly?: boolean
  /** 模型看到的那段结构化说明。 */
  description: string
  /** 见 ToolContractDescriptionSpec.usageSkillId：companion skill 的 id，透到工具页卡片。 */
  usageSkillId?: string
  /** 入参 schema。 */
  schema: z.ZodType<TInput>
  /** 按工具面档位给的入参与说明覆盖。 */
  surfaces?: Partial<Record<ToolSurfaceProfileId, ToolContractSurface<any, TInput, TContext>>>
  /** 调用它需要的权限。 */
  permissions: TPermission[]
  /** 能力声明：副作用、读写域、并发性。 */
  capabilities?: ToolCapabilitySchema
  /** 消费这条工具的回执，模型必须先支持的输入形态（比如截图要 image）。 */
  requiredModelInputModalities?: readonly AgentModelInputModality[]
  /** 暴露策略：分层、排序、是否常驻。 */
  exposure?: ToolExposurePolicy
  /**
   * 工具输出是否必须**保持内联**、禁止被卸载成 payload 引用。
   * 用于发现/索引/目录类工具——它们的输出就是模型当下要读的内容，
   * 被卸载后模型还得召回，自我抵消。声明在工具上、单一来源、易维护。
   */
  outputInline?: boolean
  /** 运行依赖不存在时不进入工具发现目录。 */
  hideWhenUnavailable?: boolean
  /** 当前上下文里这条工具能不能用。 */
  isAvailable?: (ctx: TContext) => boolean
  /**
   * `isAvailable` 为假时给发现层的**具体原因**。
   *
   * 留在发现层要成立，就必须同时给出**为什么不可用、谁来解除**。返回 null = 没有比泛化文案更具体的可说的。
   * 模型自己能解除的前置不该走这里，那种前置应当在执行期回可执行错误。
   */
  unavailableReason?: (ctx: TContext) => Nullable<string>
  /** 这次入参下能不能与别的调用并发。 */
  isConcurrencySafe?: (input: TInput) => boolean
  /** 真正干活的那个函数。 */
  execute: ToolContractExecute<TInput, TContext, TResult>
}

/** 定义一个工具面档位时要填的东西：说明规格加档位自己的 schema 与折回函数。 */
export interface DefineToolContractSurfaceInput<
  TSurfaceInput extends Record<string, unknown> = Record<string, unknown>,
  TBaseInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
> extends ToolContractDescriptionSpec {
  schema: z.ZodType<TSurfaceInput>
  normalize?: (input: TSurfaceInput, ctx: TContext) => TBaseInput
}

/** 定义一条工具的运行期规格时要填的东西。 */
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
  /** 见 ToolContractRuntimeSpec.outputInline：输出禁止卸载，始终内联。 */
  outputInline?: boolean
  hideWhenUnavailable?: boolean
  isAvailable?: (ctx: TContext) => boolean
  /** 见 ToolContractRuntimeSpec.unavailableReason：不可用时给发现层的具体原因。 */
  unavailableReason?: (ctx: TContext) => Nullable<string>
  isConcurrencySafe?: (input: TInput) => boolean
  execute: ToolContractExecute<TInput, TContext, TResult>
}

/**
 * 造一个「定义本空间工具」的函数时给的选项：类别怎么查、要不要套入参复用信封、参数契约第几版。
 * 各空间只保留一行 `const defineXTool = toolContracts.createDefiner(…)`，不再各写一份同构的壳子。
 */
export interface ToolDefinerOptions<TContext> {
  /**
   * 按工具名给出类别；固定一个类别的空间直接返回那个常量。
   * 每条工具自己写 `category` 的空间不填这一格；两处都没有时定义期报 INVARIANT。
   */
  categoryOf?: (name: string) => ToolCategoryId
  /**
   * 给声明了 `inputReuse: true` 的工具套上入参复用信封。宿主没有复用账房时不填，
   * 这时 `inputReuse` 声明会被忽略（示例仍按原 schema 校验）。
   */
  inputReuse?: (schema: z.ZodType) => z.ZodType
  /** 本空间的参数契约版本；工具没自己声明时填它。 */
  contractVersion?: number
  /** 包一层 execute：空间想在每次调用前后加统一处理（比如先还原复用入参）时给。 */
  wrapExecute?: <TInput extends Record<string, unknown>>(
    tool: ToolContractRuntimeSpec<TInput, TContext, unknown, ToolPermission>
  ) => ToolContractExecute<Record<string, unknown>, TContext, unknown>
}

/** 定义本空间一条工具的函数：类别、契约版本与入参复用信封都已经按空间填好。 */
export type ToolDefiner<TContext> = <TInput extends Record<string, unknown>>(
  input: Omit<DefineToolRuntimeSpecInput<TInput, TContext, unknown, ToolPermission>, 'category'> & {
    /** 工具名；类别按它查表。 */
    name: string
    /** 工具所属类别；空间按名查表时不填。 */
    category?: ToolCategoryId
    /** 失败后入参可复用：失败回执带 inputReuse，下一次用 reuse + changes 只改出问题的字段。 */
    inputReuse?: boolean
  }
) => ToolContractRuntimeSpec<TInput, TContext, unknown, ToolPermission>

// ── 挂进内核 ─────────────────────────────────────────────────────

/** 把工具集合包装成内核可调用操作表时的选项。 */
export interface ToolCallableOperationsOptions {
  /** 报错与缺省理由里称呼这组能力的中文名，比如「脚本」。 */
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

/** 一个空间注册进内核的能力服务至少要有的那一格：工具集合原样交出去；各空间的服务在这之上再加自己的。 */
export interface ToolCapabilityService<TTools> {
  /** 本空间的工具集合，按工具名索引。 */
  readonly tools: TTools
}

/** 把一个空间的工具集合做成内核模块时要填的东西。 */
export interface ToolKernelModuleOptions<
  TContext extends { abortSignal: AbortSignal },
  TService extends ToolCapabilityService<unknown>,
> {
  /** 模块与能力令牌的身份 id。 */
  id: string
  /** 模块版本。 */
  version: string
  /** 模块声明的内核权限。 */
  permissions: readonly string[]
  /** 能力服务在内核里的身份令牌。 */
  token: CapabilityToken<TService>
  /** 本空间的工具集合，按工具名索引。 */
  tools: TService['tools']
  /** 宿主给的上下文解析器；不给时一个操作都不登记，只能读工具说明。 */
  resolveContext: LooseOptional<ToolContextResolver<TContext>>
  /** 报错与缺省理由里称呼这组能力的中文名。 */
  label: string
  /** 工具抛出的领域错误怎么翻成对外的错误；不给就原样抛出。 */
  mapError?: (error: unknown) => unknown
}

// ── 发给模型的 schema 包 ─────────────────────────────────────────

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

/** 进包的一条工具：名字、说明与它的 zod 入参 schema。 */
export interface ToolSchemaSource {
  name: string
  description: string
  schema: z.ZodType
}

/** 造一份工具 schema 包时的中间状态：共享定义的引用前缀与内联阈值。 */
export interface ToolSchemaBundleContext {
  sharedSchemaRefPrefix: string
  bundleSharedSchemaRefPrefix: string
  inlineSharedDefMaxChars: number
}

/** 一份 JSON Schema 对象。 */
export type JsonSchemaObject = Record<string, unknown>

// ── 审批与有界读 ─────────────────────────────────────────────────

/** 一次必须由用户亲自裁决的审批请求可以填的东西：手动确认与是否记住风险分类两格由构造器补。 */
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

/** 审批端口要用到的那几格会话事实：确认卡记账、任务审批记录、会话内已确认的风险分类。 */
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

// ── 入参复用信封 ─────────────────────────────────────────────────

/**
 * 入参复用信封包裹后的 schema 形状。
 *
 * `withToolInputReuse` 在原 schema 的根对象上补 `reuse` 与 `changes` 两个字段：
 * 模型给了 `reuse` 就按上一次的入参加补丁跑，没给就走原 schema。这里写出包裹后的完整类型，
 * 让消费方在 `z.infer` 时仍能拿到两种输入形态的联合。
 */
export type ToolInputReuseEnvelopeSchema<T extends z.ZodType> = z.ZodPipe<z.ZodObject<{
    reuse: z.ZodOptional<z.ZodString>;
    changes: z.ZodOptional<z.ZodArray<z.ZodObject<{
        op: z.ZodEnum<{
            remove: "remove";
            set: "set";
        }>;
        path: z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        value: z.ZodOptional<z.ZodUnknown>;
    }, z.core.$strict>>>;
}, z.core.$strict>, z.ZodTransform<ToolInputReuseEnvelopeShape | Awaited<z.core.output<T>>, ToolInputReuseEnvelopeShape>>

/** 复用信封在根对象上补的那两个字段：给了 `reuse` 就按上一次入参加补丁跑，没给就走原 schema。 */
export interface ToolInputReuseEnvelopeShape {
  /** 上一次尝试的 callId；给了它才走复用。 */
  reuse?: string
  /** 相对上一次入参的补丁；只允许 set / remove 两种操作。 */
  changes?: Array<{ op: 'remove' | 'set'; path: Array<string | number>; value?: unknown }>
}

/** 给一份工具 schema 套上入参复用信封的工厂签名。 */
export type WithToolInputReuse = <T extends z.ZodType>(schema: T) => ToolInputReuseEnvelopeSchema<T>
