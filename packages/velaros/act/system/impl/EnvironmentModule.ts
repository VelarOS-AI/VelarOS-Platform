import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import type { EnvironmentRegistryApi } from '../contract/provides.js'
import { VelarSystemEnvironmentModule } from '../contract/surface.js'

import { environmentOperations } from './EnvironmentOperations.js'

/** 自管环境通过生成的合同进入唯一 Kernel 派发链。 */
export interface EnvironmentModuleApi {
  /** 固定 agent 环境，权限与调用身份继续来自 Kernel。 */
  create(registry: EnvironmentRegistryApi): OperationModuleDefinition
}

class EnvironmentModule implements EnvironmentModuleApi {
  public create(registry: EnvironmentRegistryApi): OperationModuleDefinition {
    return capabilityModules.create({
      surface: VelarSystemEnvironmentModule,
      implementation: environmentOperations,
      instanceId: `environment:${registry.directory}`,
      context: (call) => ({ registry, abortSignal: call.signal, recordEffect: call.recordEffect }),
    })
  }
}

/** 模型通过 velaros:system 的 environment 成员管理环境。 */
export const environmentModule: EnvironmentModuleApi = new EnvironmentModule()
