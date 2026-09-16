/**
 * 工具契约里带 schema 与 execute 的那些形状：定义一条工具要填什么、定义出来的运行期规格长什么样、
 * 挂进内核时要给什么。它们引了 zod 与内核的 ABI，所以不进可移植文件。
 */

import type { z } from 'zod'

import type { CapabilityToken } from '@velaros-ai/kernel/contracts/abi'

import type { ToolContextResolver } from '../contract/requires.js'

import type {
  NonEmptyToolContractList,
  ToolCapabilitySchema,
  ToolCategoryId,
  ToolContractDescriptionSpec,
  ToolContractRole,
  ToolExposurePolicy,
  ToolInputReuseMigrationRequest,
  ToolModelInputModality,
  ToolPermission,
  ToolSurfaceProfileId,
} from './tool-contract.js'

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
  role: ToolContractRole
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
  requiredModelInputModalities?: readonly ToolModelInputModality[]
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
  requiredModelInputModalities?: readonly ToolModelInputModality[]
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

/** 定义一条工具契约（只有形状与说明，不含运行期独有的那几格）时要填的东西。 */
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
  requiredModelInputModalities?: readonly ToolModelInputModality[]
  exposure?: ToolExposurePolicy
  hideWhenUnavailable?: boolean
  isAvailable?: (ctx: TContext) => boolean
  /** 见 ToolContractRuntimeSpec.unavailableReason：不可用时给发现层的具体原因。 */
  unavailableReason?: (ctx: TContext) => Nullable<string>
  isConcurrencySafe?: (input: TInput) => boolean
  execute: (input: TInput, ctx: TContext) => Promise<unknown> | unknown
}

/** 定义出来的一条工具契约：说明规格与渲染好的说明并存，示例原样留着。 */
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

/**
 * 造一个「定义本空间工具」的函数时给的选项：类别怎么查、要不要套入参复用信封、参数契约第几版。
 * 各空间只保留一行 `const defineXTool = createToolDefiner(…)`，不再各写一份同构的壳子。
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

/** 造一份工具 schema 包时的中间状态：共享定义的引用前缀与内联阈值。 */
export interface ToolSchemaBundleContext {
  sharedSchemaRefPrefix: string
  bundleSharedSchemaRefPrefix: string
  inlineSharedDefMaxChars: number
}

/** 进包的一条工具：名字、说明与它的 zod 入参 schema。 */
export interface ToolSchemaSource {
  name: string
  description: string
  schema: z.ZodType
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
