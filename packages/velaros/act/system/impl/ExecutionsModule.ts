import { AppError } from '@velaros-ai/core/error'
import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import { SystemContract } from '../contract/constants.js'
import type { ExecutionsHost } from '../contract/requires.js'
import { VelarExecutionsModule } from '../contract/surface.js'

import { executionsOperations } from './ExecutionsOperations.js'

/** 当前会话和调用者身份由宿主绑定。 */
export interface ExecutionsModuleApi {
  /** 以当前调用会话和执行身份装配进 Kernel。 */
  create(host: ExecutionsHost): OperationModuleDefinition
}

class ExecutionsModule implements ExecutionsModuleApi {
  public create(host: ExecutionsHost): OperationModuleDefinition {
    const executions = host.executions
    if (!executions) throw new AppError('UNAVAILABLE', '当前宿主未提供执行观测')
    return capabilityModules.create({
      surface: VelarExecutionsModule,
      implementation: executionsOperations,
      instanceId: 'standard:executions',
      generation: SystemContract.generation,
      context: (call) => ({
        executions: executions(call.invocation.sessionId),
        executionId: call.invocation.executionId,
        abortSignal: call.signal,
        recordEffect: call.recordEffect,
      }),
    })
  }
}

/** 当前任务的有界执行状态与定向停止能力。 */
export const executionsModule: ExecutionsModuleApi = new ExecutionsModule()
