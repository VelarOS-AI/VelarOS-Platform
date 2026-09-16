import type { AgentTurnRouteIdentity, StreamTurnContextPayload } from '../../types/agent'
import type { ExecutionRouteProvider, ResolvedTaskRoute } from '../../types/records.js'
import { emptyRoute, resolveTurnRouteIdentity } from '../../utils/records/exec-workflow-route'

import { ExecPlanState } from './ExecPlanState'

/**
 * 工作流路线解析：拿「角色 + 工作流类型 + 期望产出」去问注入的 `ExecutionRouteProvider` 要一条路线，
 * 再把路线里的执行计划按当前状态刷一遍才交出去。
 *
 * 没有 provider、或 provider 认不出这个身份时，给一条只带 workflowType 与 expectedOutput 的空路线，永不抛错。
 * 实现是 `ExecWorkflowRoute`（对外别名 `ExecutionWorkflowRouteHelper`），由 `ExecRouting` 持有。
 */
export interface ExecWorkflowRouteApi {
  /** 从流式回合上下文里取角色与工作流标识，再解析路线。 */
  resolveFromTurnContext(payload: StreamTurnContextPayload): ResolvedTaskRoute
  /** 按给定的角色/工作流标识解析路线；provider 没给路线时回退成空路线，执行计划一律刷新后返回。 */
  resolveFromRouteIdentity(identity: AgentTurnRouteIdentity): ResolvedTaskRoute
}

class ExecWorkflowRoute implements ExecWorkflowRouteApi {
  constructor(
    private readonly provider?: ExecutionRouteProvider,
    private readonly planStateHelper = new ExecPlanState()
  ) {}

  public resolveFromTurnContext(payload: StreamTurnContextPayload): ResolvedTaskRoute {
    return this.resolveFromRouteIdentity(resolveTurnRouteIdentity(payload))
  }

  public resolveFromRouteIdentity(identity: AgentTurnRouteIdentity): ResolvedTaskRoute {
    const route = this.provider?.resolve(identity) ?? emptyRoute(identity)
    return {
      ...route,
      executionPlan: this.planStateHelper.refreshExecutionPlan(route.executionPlan),
    }
  }
}

export { ExecWorkflowRoute as ExecutionWorkflowRouteHelper, ExecWorkflowRoute, type ResolvedTaskRoute, resolveTurnRouteIdentity }