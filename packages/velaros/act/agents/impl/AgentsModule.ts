import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { VelarosRuntimeContract } from '../../runtime/contract/constants.js'
import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import type { AgentsHost } from '../contract/requires.js'
import { VelarAgentsModule } from '../contract/surface.js'

import { agentsOperations } from './AgentsOperations.js'

/** 同一 Act 运行时上的有界子任务：子任务继承父任务的能力与权限，预算由宿主配置。 */
export interface AgentsModuleApi {
  /** 注入宿主端口，装配到共享 Kernel。 */
  create(host: AgentsHost): OperationModuleDefinition
}

class AgentsModule implements AgentsModuleApi {
  public create(host: AgentsHost): OperationModuleDefinition {
    return capabilityModules.create({
      surface: VelarAgentsModule,
      implementation: agentsOperations,
      instanceId: 'standard:agents',
      generation: VelarosRuntimeContract.generation,
      context: (call) => ({
        agents: host.agents,
        sessionId: call.invocation.sessionId,
        profiles: () => host.agentProfiles(),
        runSignal: () => host.programs(call.invocation.sessionId).runSignal(),
        abortSignal: call.signal,
      }),
    })
  }
}

/** 注入端口之后接入唯一调用链。 */
export const agentsModule: AgentsModuleApi = new AgentsModule()
