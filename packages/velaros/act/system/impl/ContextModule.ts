import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import { ContextMaterialsModuleId, SystemContract } from '../contract/constants.js'
import type { ContextMaintenanceHost } from '../contract/requires.js'
import { VelarContextMaterialsModule } from '../contract/surface.js'

import { contextMaterialsOperations } from './ContextMaterialsOperations.js'

/** 整理会话的只读父快照能力。 */
export interface ContextModuleApi {
  /** 只生成固定快照的 list/read 与交补丁的 submit。 */
  create(host: ContextMaintenanceHost): readonly OperationModuleDefinition[]
}

class ContextModule implements ContextModuleApi {
  public create(host: ContextMaintenanceHost): readonly OperationModuleDefinition[] {
    return [capabilityModules.create({
      surface: VelarContextMaterialsModule,
      implementation: contextMaterialsOperations,
      instanceId: `standard:${ContextMaterialsModuleId}`,
      generation: SystemContract.generation,
      summary: '读取当前整理任务的固定父快照，返回原文引用与分页',
      context: (call) => {
        const sessionId = call.invocation.sessionId
        return {
          materials: {
            list: (query, signal) => host.listMaterials(sessionId, query, signal),
            read: (input, signal) => host.readMaterial(sessionId, input, signal),
            submit: (patch, signal) => host.submitPatch(sessionId, patch, signal),
          },
          abortSignal: call.signal,
        }
      },
    })]
  }
}

/** 工具入口与资料读取共享当前整理服务。 */
export const contextModule: ContextModuleApi = new ContextModule()
