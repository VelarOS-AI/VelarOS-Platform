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

/** Product-owned Model collection implements catalog, auth, health and fallback. */
export interface TeamModelRoutingPort {
  resolve(request: TeamModelRouteRequest): TeamModelRouteResult
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
