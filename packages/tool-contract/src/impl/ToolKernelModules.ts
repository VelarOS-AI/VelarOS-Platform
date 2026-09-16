/**
 * 把一个空间的工具集合挂进 VelaOS 内核：严格解析线上入参、包成内核可调用的操作、再包成内核模块。
 * 接口 `ToolKernelModulesApi` 在本文件的类上方；整个进程一份 `toolKernelModules`。
 */

import { z } from 'zod'

import { isFalse, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  KernelCallableCapabilityOperation,
  KernelModuleDefinition,
} from '@velaros-ai/kernel'
import {
  kernelModules,
} from '@velaros-ai/kernel'
import {
  KernelVersionAxes,
} from '@velaros-ai/kernel/contracts'

import type { ToolContextResolver } from '../contract/requires.js'
import type {
  ToolCallableOperationsOptions,
  ToolCapabilityService,
  ToolKernelModuleOptions,
} from '../types/toolkit.js'
import { isCallableToolSpec } from '../utils/kernel.js'

/**
 * 工具集合挂进内核的唯一路径，实例是 `toolKernelModules`。
 *
 * 每次调用固定四步：先用工具自己的 schema 严格解析入参（坏入参不会惊动宿主的上下文解析），
 * 再向宿主解析一次上下文并换上内核给的 abortSignal，核一次可用性与取消，最后执行；
 * 工具抛的领域错误交给 `mapError` 翻一次。宿主没给上下文解析器时一个操作都不登记——
 * 工具说明仍可读，但谁都调不动。
 */
export interface ToolKernelModulesApi {
  /** 用工具的 schema 严格解析线上入参：不是对象直接拒；对象 schema 拒收未知字段；报错带字段路径。 */
  parseWireInput(tool: { schema: z.ZodType }, input: unknown, label: string): Record<string, unknown>
  /** 把一组工具包装成内核可调用的操作，按工具名登记；集合里混进不是工具的值，当场报 INVARIANT。 */
  callableOperations<TContext extends { abortSignal: AbortSignal }>(
    tools: Readonly<Record<string, unknown>>,
    resolveContext: LooseOptional<ToolContextResolver<TContext>>,
    options: ToolCallableOperationsOptions
  ): Readonly<Record<string, KernelCallableCapabilityOperation>>
  /**
   * 把一个空间的工具集合做成内核模块：激活时按工具名登记成可调用操作，连同工具集合一起注册成能力服务。
   * system、project、office 原来各写一份逐行同构的样板，现在都用这里；要额外挂运行时方法的空间
   * （computer）自己写 activate，只用 `callableOperations`。
   */
  define<
    TContext extends { abortSignal: AbortSignal },
    TService extends ToolCapabilityService<unknown>,
  >(
    options: ToolKernelModuleOptions<TContext, TService>
  ): KernelModuleDefinition
}

class ToolKernelModules implements ToolKernelModulesApi {
  public parseWireInput(tool: { schema: z.ZodType }, input: unknown, label: string): Record<string, unknown> {
    if (!isPlainObject(input)) throw new AppError('VALIDATION', `${label}能力的入参不合法：入参必须是对象`)
    const schema = tool.schema instanceof z.ZodObject ? tool.schema.strict() : tool.schema
    const parsed = schema.safeParse(input)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
      throw new AppError('VALIDATION', `${label}能力的入参不合法：${detail}`)
    }
    return parsed.data as Record<string, unknown>
  }

  public callableOperations<TContext extends { abortSignal: AbortSignal }>(
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
          const parsed = this.parseWireInput(tool, input, options.label)
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

  public define<
    TContext extends { abortSignal: AbortSignal },
    TService extends ToolCapabilityService<unknown>,
  >(
    options: ToolKernelModuleOptions<TContext, TService>
  ): KernelModuleDefinition {
    return kernelModules.define({
      manifest: {
        id: options.id,
        version: options.version,
        apiVersion: KernelVersionAxes.moduleApi,
        provides: [options.token],
        requires: [],
        optionalRequires: [],
        permissions: [...options.permissions],
        isolation: 'in-process',
      },
      activate: (context) => {
        const callable = kernelModules.callable(
          this.callableOperations(
            options.tools as Readonly<Record<string, unknown>>,
            options.resolveContext,
            { label: options.label, mapError: options.mapError },
          ),
        )
        const tools: Record<string, unknown> = options.tools as Record<string, unknown>
        // 服务形状由内核可调用面加工具集合拼出来，各空间的服务接口都是它的子类型：
        // 先按约束声明一次，再向下收成 TService，避免两段式断言。
        const service: ToolCapabilityService<unknown> = Object.freeze({
          ...callable,
          tools: Object.freeze({ ...tools }),
        })
        context.registerService(options.token, service as TService)
      },
    })
  }
}

/** 整个进程只有一份的内核挂载器。 */
export const toolKernelModules: ToolKernelModulesApi = new ToolKernelModules()
