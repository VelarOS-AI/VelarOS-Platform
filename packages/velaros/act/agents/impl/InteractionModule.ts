import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { VelarosRuntimeContract } from '../../runtime/contract/constants.js'
import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import type { InteractionHost } from '../contract/requires.js'
import { VelarInteractionModule } from '../contract/surface.js'

import { interactionOperations } from './InteractionOperations.js'

/** 请求用户提供信息或确认，答案绑定当前运行与请求身份。 */
export interface InteractionModuleApi {
  /** 注入宿主端口，装配到共享 Kernel。 */
  create(host: InteractionHost): OperationModuleDefinition
}

class InteractionModule implements InteractionModuleApi {
  public create(host: InteractionHost): OperationModuleDefinition {
    return capabilityModules.create({
      surface: VelarInteractionModule,
      implementation: interactionOperations,
      instanceId: 'standard:interaction',
      generation: VelarosRuntimeContract.generation,
      context: (call) => ({
        interaction: host.programs(call.invocation.sessionId),
        abortSignal: call.signal,
      }),
    })
  }
}

/** 注入端口之后接入唯一调用链。 */
export const interactionModule: InteractionModuleApi = new InteractionModule()
