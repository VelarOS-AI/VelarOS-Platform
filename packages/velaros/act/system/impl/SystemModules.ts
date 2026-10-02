import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import type { SystemHost } from '../contract/requires.js'
import { isSystemMember } from '../utils/members.js'

import { contextModule } from './ContextModule.js'
import { goalModule } from './GoalModule.js'
import { memoryModule } from './MemoryModule.js'
import { modulesModule } from './ModulesModule.js'
import { programsModule } from './ProgramsModule.js'
import { storeModule } from './StoreModule.js'

/** 系统身份与实际合同的唯一装配。 */
export interface SystemModulesApi {
  /** 状态由真实调用会话解析。 */
  create(host: SystemHost): readonly OperationModuleDefinition[]
  /** 业务模块不能占用系统身份。 */
  owns(moduleId: string): boolean
}

class SystemModules implements SystemModulesApi {
  public create(host: SystemHost): readonly OperationModuleDefinition[] {
    return [
      ...(host.stores
        ? [
            storeModule.create(host.stores),
            storeModule.create(host.stores, 'write'),
            storeModule.create(host.stores, 'read'),
          ]
        : []),
      modulesModule.create(host),
      ...(host.programCatalog ? [programsModule.create(host)] : []),
      goalModule.create(host),
      memoryModule.create(host, false),
      ...(host.longTermMemory
        ? [memoryModule.create(host, host.longTermMemory.organize, true)]
        : []),
      ...(host.maintenance
        ? [memoryModule.create(host), ...contextModule.create(host.maintenance)]
        : []),
    ]
  }

  public owns(moduleId: string): boolean {
    return isSystemMember(moduleId)
  }
}

/** 系统能力与业务能力共用唯一执行链。 */
export const systemModules: SystemModulesApi = new SystemModules()
