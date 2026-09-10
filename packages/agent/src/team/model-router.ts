import type { AgentModelInputModality, ThinkingDepth } from '@velaros-ai/agent/protocol'
import { toNullable } from '@velaros-ai/core'

import type {
  AgentModelProvider,
  AgentModelRequestOptions,
} from '../agent/model'

export interface SubAgentRuntimeOverride {
  provider: AgentModelProvider
  providerId: string
  model: string
  supportedInputModalities?: readonly AgentModelInputModality[]
  modelRequestOptions?: AgentModelRequestOptions
  thinkingDepth?: ThinkingDepth
}

export interface TeamModelRouteResult {
  runtimeOverride: SubAgentRuntimeOverride
  trace: unknown
}

export interface TeamModelRouteRequest {
  workerType: string
  category: string
  selection: unknown
  runtimeContext: unknown
}

/** 子 Agent 可被指定的一个模型：与主模型同一厂商、宿主已配置可用。 */
export interface TeamSelectableModel {
  id: string
  label?: string
}

/** Product-owned Model collection implements catalog, auth, health and fallback. */
export interface TeamModelRoutingPort {
  resolve(request: TeamModelRouteRequest): TeamModelRouteResult
  /**
   * 列出与 `selection`（主模型的模型选择）同一厂商、可供子 Agent 使用的模型。
   * 主 Agent 经 `agent:dispatch.model` 指定模型时据此校验；返回 null 或不实现 = 宿主不提供目录
   * （例如自定义厂商接受任意模型 id），此时按原样透传。
   */
  listSelectableModels?(
    selection: unknown
  ): Nullable<readonly TeamSelectableModel[]> | Promise<Nullable<readonly TeamSelectableModel[]>>
  markSuccess?(providerId: string): void
  markFailure?(providerId: string, reason: string): void
  createRelaxedRoute?(
    route: TeamModelRouteResult,
    reason: string
  ): LooseOptional<TeamModelRouteResult>
}

class TeamModelRouter {
  constructor(private readonly routing: TeamModelRoutingPort) {}

  public resolve(
    workerType: string,
    category: string,
    selection: unknown,
    runtimeContext: unknown
  ): TeamModelRouteResult {
    return this.routing.resolve({ workerType, category, selection, runtimeContext })
  }

  public async listSelectableModels(
    selection: unknown
  ): Promise<Nullable<readonly TeamSelectableModel[]>> {
    return toNullable(await this.routing.listSelectableModels?.(selection))
  }

  public markSuccess(providerId: string): void {
    this.routing.markSuccess?.(providerId)
  }

  public markFailure(providerId: string, reason: string): void {
    this.routing.markFailure?.(providerId, reason)
  }

  public createRelaxedRoute(
    route: TeamModelRouteResult,
    reason: string
  ): LooseOptional<TeamModelRouteResult> {
    return toNullable(this.routing.createRelaxedRoute?.(route, reason))
  }
}

export { TeamModelRouter }
