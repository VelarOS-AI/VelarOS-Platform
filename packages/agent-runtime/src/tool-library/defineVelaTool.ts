// tool-library 工具定义入口：generic 工具经此绑定核心面 KernelToolContext。
// 与 Desktop 的 defineVelaTool（默认完整 ToolContext）同形，只是默认上下文收窄到 host 无关核心面；
// 装配进宿主完整 ToolContext 时靠 TContext 逆变无摩擦兼容（宿主更宽，赋给更窄的核心面契约）。

import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
  type ToolContractSurface,
} from '@velaros-ai/core/tool-contract'
import type { ToolPermission } from '@velaros-ai/core/types'

import type { KernelToolContext } from './KernelToolContext'

export type VelaToolSurface<
  TSurfaceInput extends Record<string, any> = Record<string, any>,
  TBaseInput extends Record<string, any> = Record<string, any>,
  TCtx extends KernelToolContext = KernelToolContext,
> = ToolContractSurface<TSurfaceInput, TBaseInput, TCtx>

/** generic 工具的统一形状；TCtx 默认核心面 KernelToolContext。 */
export type VelaTool<
  TInput extends Record<string, any> = Record<string, any>,
  TCtx extends KernelToolContext = KernelToolContext,
> = ToolContractRuntimeSpec<TInput, TCtx, any, ToolPermission>

export type DefineVelaToolInput<
  TInput extends Record<string, any> = Record<string, any>,
  TCtx extends KernelToolContext = KernelToolContext,
> = DefineToolRuntimeSpecInput<TInput, TCtx, any, ToolPermission>

export function defineVelaTool<
  TInput extends Record<string, any>,
  TCtx extends KernelToolContext = KernelToolContext,
>(input: DefineVelaToolInput<TInput, TCtx>): VelaTool<TInput, TCtx> {
  return defineToolRuntimeSpec(input)
}
