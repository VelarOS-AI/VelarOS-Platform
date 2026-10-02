import { AppError } from '@velaros-ai/core/error'
import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import { SystemContract } from '../contract/constants.js'
import type { ProgramsHost } from '../contract/requires.js'
import { VelarProgramsModule } from '../contract/surface.js'

import { programsOperations } from './ProgramsOperations.js'

/** 命名程序只装配当前会话的发布与目录口。 */
export interface ProgramsModuleApi {
  /** 把宿主的当前会话目录接到共享 Kernel；端口缺失时不装配。 */
  create(host: ProgramsHost): OperationModuleDefinition
}

class ProgramsModule implements ProgramsModuleApi {
  public create(host: ProgramsHost): OperationModuleDefinition {
    if (!host.programCatalog) throw new AppError('UNAVAILABLE', '当前宿主未提供程序目录')
    const catalog = host.programCatalog
    return capabilityModules.create({
      surface: VelarProgramsModule,
      implementation: programsOperations,
      instanceId: 'standard:programs',
      generation: SystemContract.generation,
      context: (call) => ({
        catalog: catalog(call.invocation.sessionId),
        abortSignal: call.signal,
      }),
    })
  }
}

/** 发布与发现接入唯一 Kernel 调用链。 */
export const programsModule: ProgramsModuleApi = new ProgramsModule()
