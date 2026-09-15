/**
 * 工具：定义系统工具、严格解析工具入参、把工具包装成内核可调用的操作。
 */

import { z } from 'zod'

import type { ToolPermission } from '@velaros-ai/agent/protocol'
import type { DefineToolRuntimeSpecInput } from '@velaros-ai/agent/tool-contract'
import { defineToolRuntimeSpec } from '@velaros-ai/agent/tool-contract'
import { isFalse, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { KernelCallableCapabilityOperation } from '@velaros-ai/kernel/contracts/abi'

import type { SystemToolName } from '../contract/system.js'
import { SystemToolCategoryByName } from '../contract/system.js'
import type { VelaTool } from '../interface/provides.js'
import type { SystemToolContext, SystemToolContextResolver } from '../interface/requires.js'

type DefineSystemToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, SystemToolContext, unknown, ToolPermission>,
  'category'
> & { name: SystemToolName }

/** 定义一个系统工具：类别按工具名自动查表填上，保证一个工具只属于一个类别。 */
export function defineSystemTool<TInput extends Record<string, unknown>>(
  input: DefineSystemToolInput<TInput>
): VelaTool<TInput> {
  return defineToolRuntimeSpec({
    ...input,
    category: SystemToolCategoryByName[input.name],
  })
}

/** 生成「能力调用入参不合法」的错误。 */
function invalidCapabilityInput(detail: string): AppError {
  return new AppError('VALIDATION', `System capability input is invalid: ${detail}`)
}

/** 用工具的 schema 严格解析入参：未知字段直接拒绝，报错时带出字段路径。 */
export function parseToolInput(tool: VelaTool, input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) throw invalidCapabilityInput('expected an object payload')

  const schema = tool.schema instanceof z.ZodObject
    ? tool.schema.strict()
    : tool.schema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw invalidCapabilityInput(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
    )
  }
  return parsed.data
}

/**
 * 把一组工具包装成内核可调用的操作，按工具名登记。
 * 每次调用先用 schema 严格解析入参，再向宿主解析一次上下文，工具在该上下文里不可用时报 UNAVAILABLE；宿主没给上下文解析器时一个操作都不登记。
 */
export function createSystemCallableOperations(
  tools: Readonly<Record<string, unknown>>,
  resolveContext: LooseOptional<SystemToolContextResolver>,
): Readonly<Record<string, KernelCallableCapabilityOperation>> {
  if (!resolveContext) return {}

  const operations: Record<string, KernelCallableCapabilityOperation> = {}
  for (const [fallbackName, candidate] of Object.entries(tools)) {
    const tool = candidate as VelaTool
    const operation = tool.name ?? fallbackName
    operations[operation] = {
      metadata: {
        permissions: [...new Set(tool.permissions)],
        reason: tool.capabilities?.reason
          ?? `Invoke system tool operation "${operation}".`,
      },
      async invoke(scope, input, signal) {
        const parsed = parseToolInput(tool, input)
        const resolvedContext = await resolveContext(scope, signal)
        const toolContext: SystemToolContext = {
          ...resolvedContext,
          abortSignal: signal,
        }
        if (isFalse(tool.isAvailable?.(toolContext))) {
          throw new AppError(
            'UNAVAILABLE',
            `System capability operation "${operation}" is unavailable in the resolved context.`
          )
        }
        signal.throwIfAborted()
        return tool.execute(parsed, toolContext)
      },
    }
  }
  return operations
}
