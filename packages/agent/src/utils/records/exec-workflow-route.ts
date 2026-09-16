// ExecWorkflowRoute 用到的纯函数（不碰实例状态）。
import type { AgentTurnRouteIdentity, StreamTurnContextPayload } from '../../types/agent'
import type { ResolvedTaskRoute } from '../../types/records.js'

/** 没有路由结论时的空路由：只保留回合身份，候选角色与执行计划都空着。 */
export function emptyRoute(identity: AgentTurnRouteIdentity): ResolvedTaskRoute {
  return {
    workflowType: identity.workflowType,
    expectedOutput: identity.expectedOutput,
    suggestedNextRoles: [],
    executionPlan: [],
  }
}

/** 从回合上下文载荷里取出路由身份三件（角色、工作流类型、期望产出）。 */
export function resolveTurnRouteIdentity(
  payload: Pick<StreamTurnContextPayload, 'roleId' | 'workflowType' | 'roleExpectedOutput'>
): AgentTurnRouteIdentity {
  return {
    roleId: payload.roleId,
    workflowType: payload.workflowType,
    expectedOutput: payload.roleExpectedOutput,
  }
}
