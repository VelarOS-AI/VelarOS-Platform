/** 把一个空间的工具集合挂进内核：实现在 `@velaros-ai/tool-contract`，这里按原名转发。 */

import type { z } from 'zod'

import type {
  KernelCallableCapabilityOperation,
} from '@velaros-ai/kernel'
import { toolKernelModules } from '@velaros-ai/tool-contract'

import type { ToolCallableOperationsOptions, ToolContextResolver } from '../../types/toolkit.js'

/** 用工具的 schema 严格解析线上入参：不是对象直接拒；对象 schema 拒收未知字段；报错带字段路径。label 是这组能力的中文名。 */
export function parseToolWireInput(tool: { schema: z.ZodType }, input: unknown, label: string): Record<string, unknown> {
  return toolKernelModules.parseWireInput(tool, input, label)
}

/**
 * 把一组工具包装成内核可调用的操作，按工具名登记。每次调用：先用 schema 严格解析入参（坏入参不会触发宿主解析上下文），
 * 再向宿主解析一次上下文并换上内核给的 abortSignal，工具在该上下文里不可用时报 UNAVAILABLE，核一次取消，最后执行；工具抛的错交给 mapError。
 */
export function createToolCallableOperations<TContext extends { abortSignal: AbortSignal }>(
  tools: Readonly<Record<string, unknown>>,
  resolveContext: LooseOptional<ToolContextResolver<TContext>>,
  options: ToolCallableOperationsOptions,
): Readonly<Record<string, KernelCallableCapabilityOperation>> {
  return toolKernelModules.callableOperations(tools, resolveContext, options)
}
