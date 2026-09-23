import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { VelarosRuntimeContract } from '../../runtime/contract/constants.js'
import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import type { SearchHost } from '../contract/requires.js'
import { VelarSearchModule } from '../contract/surface.js'

import { searchOperations } from './SearchOperations.js'

/** 有界高级搜索与可恢复报告；search 只允许 execute，read 可用于 observe。 */
export interface SearchModuleApi {
  /** 注入宿主端口，装配到共享 Kernel。 */
  create(host: SearchHost): OperationModuleDefinition
}

class SearchModule implements SearchModuleApi {
  public create(host: SearchHost): OperationModuleDefinition {
    return capabilityModules.create({
      surface: VelarSearchModule,
      implementation: searchOperations,
      instanceId: 'standard:search',
      generation: VelarosRuntimeContract.generation,
      summary: '有界高级搜索与可恢复报告；search 只允许 execute，read 可用于 observe',
      context: (call) => ({ search: host.search, call }),
    })
  }
}

/** 注入端口之后接入唯一调用链。 */
export const searchModule: SearchModuleApi = new SearchModule()
