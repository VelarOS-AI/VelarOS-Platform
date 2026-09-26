import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { VelarosRuntimeContract } from '../../runtime/contract/constants.js'
import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import type { EvidenceHost } from '../contract/requires.js'
import { VelarEvidenceModule } from '../contract/surface.js'

import { evidenceOperations } from './EvidenceOperations.js'

/** 仅搜索作用域可用的真实来源检索和读取。 */
export interface EvidenceModuleApi {
  /** 注入宿主端口，装配到共享 Kernel。 */
  create(host: EvidenceHost): OperationModuleDefinition
}

class EvidenceModule implements EvidenceModuleApi {
  public create(host: EvidenceHost): OperationModuleDefinition {
    return capabilityModules.create({
      surface: VelarEvidenceModule,
      implementation: evidenceOperations,
      instanceId: 'standard:evidence',
      generation: VelarosRuntimeContract.generation,
      context: (call) => ({
        activation: host.search.activation(call.invocation.sessionId),
        abortSignal: call.signal,
      }),
    })
  }
}

/** 注入端口之后接入唯一调用链。 */
export const evidenceModule: EvidenceModuleApi = new EvidenceModule()
