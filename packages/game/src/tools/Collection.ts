import { GameToolName } from './Names.js'
import {
  gameInputTool,
  gameQueryStateTool,
  gameRunTool,
  gameSceneEditTool,
  gameScreenshotTool,
  gameStopTool,
} from './Tools.js'

export const gameTools = Object.freeze({
  [GameToolName.sceneEdit]: gameSceneEditTool,
  [GameToolName.run]: gameRunTool,
  [GameToolName.stop]: gameStopTool,
  [GameToolName.screenshot]: gameScreenshotTool,
  [GameToolName.queryState]: gameQueryStateTool,
  [GameToolName.input]: gameInputTool,
})
