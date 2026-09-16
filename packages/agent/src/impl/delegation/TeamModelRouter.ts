import { toNullable } from '@velaros-ai/core'

import type { TeamModelRoutingPort } from '../../contract/requires.js'
import type { TeamModelRouteResult, TeamSelectableModel } from '../../types/delegation.js'

/**
 * 子 Agent 模型路由的门面：把「这类 worker 该用哪个 provider / 哪个模型」整件事转交给宿主注入的路由端口。
 *
 * 自己不存任何路由策略与健康度，只负责把可选端口方法的缺席统一成 null——调用方（派发器）因此不必到处判
 * 「宿主有没有实现这个动词」。宿主装配一台，派发器持有它跟着进程活。
 */
export interface TeamModelRouterApi {
  /**
   * 解析出这次派发要用的路由（provider + 模型 + 运行期覆盖）。
   *
   * 每次派发在真正开跑前调一次；`selection` 传的是主 Agent 的模型选择本身（不是整份配置），
   * `runtimeContext` 给宿主做策略判断。端口必实现，解析不出来会抛错。
   */
  resolve(
    workerType: string,
    category: string,
    selection: unknown,
    runtimeContext: unknown
  ): TeamModelRouteResult
  /**
   * 列出同厂商下宿主已配置、可供子 Agent 指定的模型；宿主不提供目录（如自定义厂商接受任意 id）时返回 null。
   *
   * 返回 null 与返回空数组含义不同：null = 不校验、原样透传模型 id；空数组 = 一个可选的都没有。
   */
  listSelectableModels(selection: unknown): Promise<Nullable<readonly TeamSelectableModel[]>>
  /** 这个 provider 刚跑成功一次，回喂健康度。宿主没实现健康度时什么都不做。 */
  markSuccess(providerId: string): void
  /**
   * 这个 provider 刚失败一次，带理由回喂健康度。
   *
   * 调用方必须先排除中断——把用户按停止喂进来会把模型误判成「不可用」。
   */
  markFailure(providerId: string, reason: string): void
  /**
   * 首选路由失败后，问宿主要一条放宽约束的备用路由；宿主不提供降级策略或这次不给降级时返回 null。
   *
   * 返回 null 时调用方应把原错误抛出去，不要自己造备用路由。
   */
  createRelaxedRoute(
    route: TeamModelRouteResult,
    reason: string
  ): LooseOptional<TeamModelRouteResult>
}

class TeamModelRouter implements TeamModelRouterApi {
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

/** 建一台团队模型路由器：按角色与思考深度挑模型。 */
export function createTeamModelRouter(routing: TeamModelRoutingPort): TeamModelRouterApi {
  return new TeamModelRouter(routing)
}
