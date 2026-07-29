import type { z } from 'zod'

import type {
  ToolCapabilitySchema,
  ToolCategoryId,
  ToolExposurePolicy,
  ToolPermission,
  ToolRole,
  ToolSurfaceProfileId,
} from '../types/tool'

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
  /**
   * 工具契约名。手写历史测试工具可缺省；由 defineToolRuntimeSpec 构造的工具必须带上，
   * 注册表用它校验模型可调用名与契约名一致。
   */
  name?: string
  /**
   * 工具角色，决定子 Agent 暴露与读改分离归类。
   * 经 defineToolRuntimeSpec/defineVelaTool 构造的工具必带此值（来自必填的契约输入）；
   * 保留可选是为兼容少量手写 VelaTool 字面量（测试/历史适配器）。
   */
  role?: ToolContractRole
  description: string
  schema: z.ZodType<TInput>
  surfaces?: Partial<Record<ToolSurfaceProfileId, ToolContractSurface<any, TInput, TContext>>>
  permissions: TPermission[]
  capabilities?: ToolCapabilitySchema
  exposure?: ToolExposurePolicy
  /**
   * 工具输出是否必须**保持内联**、禁止被 page-out 成 payload 引用（__kernelRef）。
   * 用于发现/索引/目录类工具（如 tool_map）——它们的输出就是模型当下要读的内容，
   * 被卸载后模型还得 recall_context 召回，自我抵消。声明在工具上、单一来源、易维护。
   */
  outputInline?: boolean
  /** 运行依赖不存在时不进入工具发现目录。 */
  hideWhenUnavailable?: boolean
  isAvailable?: (ctx: TContext) => boolean
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
  exposure?: ToolExposurePolicy
  /** 见 ToolContractRuntimeSpec.outputInline：输出禁止 page-out，始终内联。 */
  outputInline?: boolean
  hideWhenUnavailable?: boolean
  isAvailable?: (ctx: TContext) => boolean
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
  exposure?: ToolExposurePolicy
  hideWhenUnavailable?: boolean
  isAvailable?: (ctx: TContext) => boolean
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
