import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
} from '@velaros-ai/core/tool-contract'
import type { ToolPermission } from '@velaros-ai/core/types'

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

export function defineGameTool<TInput extends Record<string, unknown>>(
  input: DefineGameToolInput<TInput>,
): GameTool<TInput> {
  return defineToolRuntimeSpec({ ...input, category: 'game' })
}
