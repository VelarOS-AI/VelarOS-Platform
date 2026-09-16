import { toNullable } from '@velaros-ai/core'

import type { TeamModelRoutingPort } from '../../contract/requires.js'
import type { TeamModelRouteResult, TeamSelectableModel } from '../../types/delegation.js'

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
