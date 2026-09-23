import type { OperationModuleDefinition } from '@velaros-ai/kernel'

import { capabilityModules } from '../../runtime/impl/CapabilityModules.js'
import { hasErrorCode } from '../../runtime/utils/results.js'
import { GoalModuleId, SystemContract } from '../contract/constants.js'
import type { GoalHost } from '../contract/requires.js'
import { VelarSystemGoalModule } from '../contract/surface.js'

import { goalOperations } from './GoalOperations.js'

/** 目标能力的装配；宿主删除口不进入模型合同。 */
export interface GoalModuleApi {
  /** 每次调用按调用身份解析会话的目标账本，模型不能指定其他会话。 */
  create(host: GoalHost): OperationModuleDefinition
}

class GoalModule implements GoalModuleApi {
  public create(host: GoalHost): OperationModuleDefinition {
    return capabilityModules.create({
      surface: VelarSystemGoalModule,
      implementation: goalOperations,
      instanceId: `standard:${GoalModuleId}`,
      generation: SystemContract.generation,
      summary: '跨运行的会话目标生命周期',
      context: (call) => ({ goal: host.programs(call.invocation.sessionId).goal, abortSignal: call.signal }),
      // 账本在写入前拒绝：入参不对、版本已变、另一次更新正在进行
      withoutEffect: (error) => hasErrorCode(error, ['GOAL_INPUT', 'GOAL_CONFLICT', 'GOAL_BUSY']),
    })
  }
}

/** 目标操作共享 Runtime 会话账本。 */
export const goalModule: GoalModuleApi = new GoalModule()
