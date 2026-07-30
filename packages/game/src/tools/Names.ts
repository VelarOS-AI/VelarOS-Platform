export const GameToolName = Object.freeze({
  input: 'game_input',
  queryState: 'game_query_state',
  run: 'game_run',
  sceneEdit: 'game_scene_edit',
  screenshot: 'game_screenshot',
  stop: 'game_stop',
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
