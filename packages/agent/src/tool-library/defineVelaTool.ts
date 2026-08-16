// tool-library 工具定义入口：generic 工具经此绑定核心面 KernelToolContext。
// 默认上下文收窄到 host-neutral 核心面；装配进产品宿主完整 ToolContext 时通过 TContext 逆变
// 兼容更宽的宿主上下文。

import type { ToolPermission } from '@velaros-ai/agent/protocol'
import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
  type ToolContractSurface,
} from '@velaros-ai/agent/tool-contract'

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
