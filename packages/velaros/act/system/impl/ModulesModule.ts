import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import { SystemContract } from '../contract/constants.js'
import type { ModulesHost } from '../contract/requires.js'
import { VelarModulesModule } from '../contract/surface.js'

import { modulesOperations } from './ModulesOperations.js'
import { SystemCatalog } from './SystemCatalog.js'

/** 能力发现的装配：查询当前授权包及其精确使用契约。 */
export interface ModulesModuleApi {
  /** 注入宿主端口，装配到共享 Kernel。 */
  create(host: ModulesHost): OperationModuleDefinition
}

class ModulesModule implements ModulesModuleApi {
  public create(host: ModulesHost): OperationModuleDefinition {
    const catalog = new SystemCatalog(host)
    return capabilityModules.create({
      surface: VelarModulesModule,
      implementation: modulesOperations,
      instanceId: 'standard:modules',
      generation: SystemContract.generation,
      context: (call) => {
        const sessionId = call.invocation.sessionId
        return {
          catalog: {
            list: (query) => catalog.list(sessionId, query),
            describe: (input) => catalog.describe(sessionId, input),
          },
          abortSignal: call.signal,
        }
      },
    })
  }
}

/** 注入端口之后接入唯一调用链。 */
export const modulesModule: ModulesModuleApi = new ModulesModule()
