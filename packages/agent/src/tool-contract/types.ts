import type { z } from 'zod'

import type {
  AgentModelInputModality,
  ToolCapabilitySchema,
  ToolCategoryId,
  ToolExposurePolicy,
  ToolPermission,
  ToolRole,
  ToolSurfaceProfileId,
} from '../protocol/types/tool'

import type { ToolDescriptionBudgetWaiver } from './ToolDescription'

export type NonEmptyToolContractList<T = string> = readonly [T, ...T[]]

/** 工具角色，统一别名到 core types 的 ToolRole（单一事实源，避免重复联合）。 */
export type ToolContractRole = ToolRole

export interface ToolContractDescriptionSpec {
  role: ToolContractRole
  summary: string
  suitable: NonEmptyToolContractList
  forbidden: NonEmptyToolContractList
  protocol?: NonEmptyToolContractList
  usage: NonEmptyToolContractList
  examples: NonEmptyToolContractList<Record<string, unknown>>
  notes: NonEmptyToolContractList
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

export interface ToolContractRuntimeSpec<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
  TResult = unknown,
  TPermission extends string = ToolPermission,
> {
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
> extends ToolContractDescriptionSpec {
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
> extends ToolContractDescriptionSpec {
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
  examples: NonEmptyToolContractList<Record<string, unknown>>
}
