import { AppError } from '@velaros-ai/core/error'
import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import { hasErrorCode } from '../../runtime/utils/results.js'
import { SystemContract } from '../contract/constants.js'
import type { MemoryHost } from '../contract/requires.js'
import {
  VelarSystemMemoryLocalModule,
  VelarSystemMemoryModule,
  VelarSystemMemoryPersistentLocalModule,
  VelarSystemMemoryPersistentModule,
} from '../contract/surface.js'

import type { SystemMemoryOperationsApi } from './SystemMemoryOperations.js'
import { systemMemoryOperations } from './SystemMemoryOperations.js'

/** 同一记忆实现根据装配生成可委托整理或本地操作合同。 */
export interface MemoryModuleApi {
  /** organize 控制整理委托，persistent 仅用于主线已装配长期记忆的合同。 */
  create(host: MemoryHost, organize?: boolean, persistent?: boolean): OperationModuleDefinition
}

class MemoryModule implements MemoryModuleApi {
  public create(host: MemoryHost, organize = true, persistent = false): OperationModuleDefinition {
    if (persistent && !host.longTermMemory)
      throw new AppError('VALIDATION', '长期记忆合同需要宿主作用域端口')
    const surface = persistent
      ? organize
        ? VelarSystemMemoryPersistentModule
        : VelarSystemMemoryPersistentLocalModule
      : organize
        ? VelarSystemMemoryModule
        : VelarSystemMemoryLocalModule
    return capabilityModules.create<SystemMemoryOperationsApi>({
      surface,
      implementation: systemMemoryOperations,
      instanceId: `standard:${surface.specifier}`,
      generation: SystemContract.generation,
      summary: persistent
        ? '任务工作记忆与跨会话长期记忆'
        : '当前任务的原文召回、工作笔记与材料驻留',
      context: (call) => {
        const sessionId = call.invocation.sessionId
        const maintenance = host.maintenance
        return {
          memory: host.programs(sessionId).memory,
          get plans() {
            return host.view(sessionId)
          },
          organizer: maintenance
            ? { request: (intent, signal) => maintenance.request(sessionId, intent, signal) }
            : undefined,
          // 长期记忆作用域用到才解析：只有 recall、save、remove 碰它
          get longTerm() {
            return persistent ? host.longTermMemory!.scope(sessionId) : undefined
          },
          executionId: call.invocation.executionId,
          abortSignal: call.signal,
        }
      },
      // 这些拒绝都发生在校验或版本核对通过之前，没有写下任何东西
      withoutEffect: (error) =>
        hasErrorCode(error, [
          'VALIDATION',
          'MEMORY_INPUT',
          'SCOPE_MISMATCH',
          'WORKSPACE_CONFLICT',
          'WORKSPACE_LIMIT',
          'WORKSPACE_BUSY',
          'CONTEXT_CONFLICT',
          'MEMORY_REFERENCE_KIND',
          'VIEW_SCHEMA',
        ]),
    })
  }
}

/** 同一存储与 Kernel 上的记忆装配。 */
export const memoryModule: MemoryModuleApi = new MemoryModule()
