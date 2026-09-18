/**
 * 把一个空间的工具集合做成 VelarOS 内核模块：激活时按工具名登记成可调用操作，连同工具集合一起注册成能力服务。
 * 严格解析入参、包成可调用操作的那两步在 `utils/toolkit/callable-operations.ts`。
 * 接口 `ToolKernelModulesApi` 在本文件的类上方；整个进程一份 `toolKernelModules`。
 */

import type {
  KernelModuleDefinition,
} from '@velaros-ai/kernel'
import {
  kernelModules,
} from '@velaros-ai/kernel'
import {
  KernelVersionAxes,
} from '@velaros-ai/kernel/contracts'

import type {
  ToolCapabilityService,
  ToolKernelModuleOptions,
} from '../../types/toolkit.js'
import { createToolCallableOperations } from '../../utils/toolkit/callable-operations'

/**
 * 工具集合挂进内核的唯一路径，实例是 `toolKernelModules`。
 *
 * 每次调用固定四步：先用工具自己的 schema 严格解析入参（坏入参不会惊动宿主的上下文解析），
 * 再向宿主解析一次上下文并换上内核给的 abortSignal，核一次可用性与取消，最后执行；
 * 工具抛的领域错误交给 `mapError` 翻一次。宿主没给上下文解析器时一个操作都不登记——
 * 工具说明仍可读，但谁都调不动。
 */
export interface ToolKernelModulesApi {
  /**
   * 把一个空间的工具集合做成内核模块：激活时按工具名登记成可调用操作，连同工具集合一起注册成能力服务，
   * 身份令牌是 `options.token`。能力服务的形状是内核可调用面加 `tools`，各空间的服务接口都是它的子类型。
   */
  define<
    TContext extends { abortSignal: AbortSignal },
    TService extends ToolCapabilityService<unknown>,
  >(
    options: ToolKernelModuleOptions<TContext, TService>
  ): KernelModuleDefinition
}

class ToolKernelModules implements ToolKernelModulesApi {
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
          createToolCallableOperations(
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
