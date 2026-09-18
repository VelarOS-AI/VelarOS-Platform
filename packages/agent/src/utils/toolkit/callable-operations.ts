/**
 * 把一个空间的工具集合挂进内核时的两步：严格解析线上入参、把工具集合包成内核可调用的操作。
 * 做成内核模块的那一步在 `impl/tools/ToolKernelModules.ts`（`toolKernelModules.define`）。
 */

import { z } from 'zod'

import { isArray, isFalse, isFunction, isPlainObject, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  KernelCallableCapabilityOperation,
} from '@velaros-ai/kernel'

import type { ToolContextResolver } from '../../contract/requires.js'
import type { CallableToolSpec, ToolCallableOperationsOptions } from '../../types/toolkit.js'

/** 判断集合里的一项是不是能执行的工具规格：有 execute、权限表和 schema。 */
function isCallableToolSpec<TContext>(value: unknown): value is CallableToolSpec<TContext> {
  return isPlainObject(value) && isFunction(value.execute) && isArray(value.permissions) && isPresent(value.schema)
}

/** 用工具的 schema 严格解析线上入参：不是对象直接拒；对象 schema 拒收未知字段；报错带字段路径。label 是这组能力的中文名。 */
export function parseToolWireInput(tool: { schema: z.ZodType }, input: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(input)) throw new AppError('VALIDATION', `${label}能力的入参不合法：入参必须是对象`)
  const schema = tool.schema instanceof z.ZodObject ? tool.schema.strict() : tool.schema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new AppError('VALIDATION', `${label}能力的入参不合法：${detail}`)
  }
  return parsed.data as Record<string, unknown>
}

/**
 * 把一组工具包装成内核可调用的操作，按工具名登记。每次调用固定四步：先用 schema 严格解析入参（坏入参不会惊动宿主的上下文解析），
 * 再向宿主解析一次上下文并换上内核给的 abortSignal，工具在该上下文里不可用时报 UNAVAILABLE，核一次取消，最后执行；
 * 工具抛的领域错误交给 `mapError` 翻一次。宿主没给上下文解析器时一个操作都不登记；集合里混进不是工具的值当场报 INVARIANT。
 */
export function createToolCallableOperations<TContext extends { abortSignal: AbortSignal }>(
  tools: Readonly<Record<string, unknown>>,
  resolveContext: LooseOptional<ToolContextResolver<TContext>>,
  options: ToolCallableOperationsOptions,
): Readonly<Record<string, KernelCallableCapabilityOperation>> {
  if (!resolveContext) return {}
  const operations: Record<string, KernelCallableCapabilityOperation> = {}
  for (const [fallbackName, candidate] of Object.entries(tools)) {
    if (!isCallableToolSpec<TContext>(candidate)) {
      throw new AppError('INVARIANT', `${options.label}工具「${fallbackName}」不是可执行的工具规格。`)
    }
    const tool = candidate
    const operation = tool.name ?? fallbackName
    operations[operation] = {
      metadata: {
        permissions: [...new Set(tool.permissions)],
        reason: tool.capabilities?.reason ?? `调用${options.label}工具 ${operation}。`,
      },
      invoke: async (scope, input, signal) => {
        const parsed = parseToolWireInput(tool, input, options.label)
        const context: TContext = { ...(await resolveContext(scope, signal)), abortSignal: signal }
        if (isFalse(tool.isAvailable?.(context))) {
          throw new AppError('UNAVAILABLE', `${options.label}能力 ${operation} 在解析出的上下文里不可用。`)
        }
        signal.throwIfAborted()
        try {
          return await tool.execute(parsed, context)
        } catch (error) {
          throw options.mapError ? options.mapError(error) : error
        }
      },
    }
  }
  return operations
}
