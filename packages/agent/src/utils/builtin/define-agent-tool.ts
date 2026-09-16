// tool-library 工具定义入口：generic 工具经此绑定核心面 KernelToolContext。
// 默认上下文收窄到 host-neutral 核心面；装配进产品宿主完整 ToolContext 时通过 TContext 逆变
// 兼容更宽的宿主上下文。

import type { DefineVelaToolInput,VelaTool } from '../../types/builtin.js'
import type { KernelToolContext } from '../../types/tool-context.js'
import { defineToolRuntimeSpec } from '../toolkit/define-tool-contract'

/**
 * 内置工具的声明入口：把 `DefineVelaToolInput`（name/description/schema/execute 等）原样交给
 * `defineToolRuntimeSpec` 生成运行期工具对象，本身不做任何加工，只负责把工具上下文类型钉到
 * host-neutral 的 `KernelToolContext`。`TCtx` 逆变，所以装进产品宿主更宽的 ToolContext 时仍然可用。
 */
export function defineVelaTool<
  TInput extends Record<string, any>,
  TCtx extends KernelToolContext = KernelToolContext,
>(input: DefineVelaToolInput<TInput, TCtx>): VelaTool<TInput, TCtx> {
  return defineToolRuntimeSpec(input)
}
