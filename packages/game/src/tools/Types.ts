import type { ToolExposurePolicy, ToolPermission } from '@velaros-ai/agent/protocol'
import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
} from '@velaros-ai/agent/tool-contract'

import type { GameRuntimePort, GameSceneEditorPort } from '../core/index.js'

export interface ToolGameApi {
  readonly isProjectAvailable: () => boolean
  readonly editor: GameSceneEditorPort
  readonly runtime: GameRuntimePort
}

export interface GameToolContext {
  readonly abortSignal: AbortSignal
  readonly game: ToolGameApi
}

export type GameTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, GameToolContext, unknown, ToolPermission>

type DefineGameToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, GameToolContext, unknown, ToolPermission>,
  'category'
>

/**
 * 六个 game 工具在换页预算队列里的档位——单点声明，不另立名单。
 *
 * 宿主按空间声明「哪些工具常驻」，但**常驻声明不等于免于淘汰**：真正被钉死的只有
 * 声明了常驻豁免的工具，常驻集拿到的只是排序加权；加权对组内所有工具一视同仁，
 * 于是先后由「档位 + 排位 + 结构体积 − 热度」决定——净效果是体积越大越先被换出。
 * game 空间三条全踩：默认类别是全空间最多的一档、六个工具的结构是全仓最大的几个、
 * 新会话热度恒为零。于是真机上模型说「不在工具清单里，得先换入」。
 *
 * 判据：一个空间的存在理由，不该在自己的空间里排在通用工具后面。用档位表达——
 * 工具定义处声明、随包走、别的空间不启用 game 类别因此零影响——而不是再抄一份工具名
 * 到宿主侧，那正是宿主常驻集注释里记着的、已经踩过的两份闭集分家。
 * 不取最高两档：那两档留给控制面，换页入口自己被换出去就没有自愈路径了。
 */
const GameToolExposure: ToolExposurePolicy = { tier: 'common' }

export function defineGameTool<TInput extends Record<string, unknown>>(
  input: DefineGameToolInput<TInput>,
): GameTool<TInput> {
  return defineToolRuntimeSpec({
    exposure: GameToolExposure,
    ...input,
    category: 'game',
  })
}
