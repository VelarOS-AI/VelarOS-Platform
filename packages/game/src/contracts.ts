export const GameToolName = Object.freeze({
  input: 'game:input',
  queryState: 'game:query_state',
  run: 'game:run',
  sceneEdit: 'game:scene_edit',
  screenshot: 'game:screenshot',
  stop: 'game:stop',
} as const)

export const GameToolNames = Object.freeze([
  GameToolName.sceneEdit,
  GameToolName.run,
  GameToolName.stop,
  GameToolName.screenshot,
  GameToolName.queryState,
  GameToolName.input,
] as const)

export type GameToolName = (typeof GameToolNames)[number]

export const GameModId = 'velaros.game' as const
export const GameSpaceId = 'game' as const
export const GameTurnContextSourceIds = Object.freeze([
  'game.runtime-errors',
  'game.selection',
  'game.scene-state',
] as const)
