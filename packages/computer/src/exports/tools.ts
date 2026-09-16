/**
 * 工具入口（`@velaros-ai/computer/tools`）：六个模型面工具与它们的能力档、工具上下文与宿主端口。
 * 入口名与导出名在这一轮保持不变，收口那一轮再并进根入口。
 */

export type { ComputerToolCollection, VelaTool } from '../contract/provides.js'
export type {
  ComputerToolComputerApi,
  ComputerToolContext,
  ToolComputerApi,
  ToolContext,
} from '../contract/requires.js'
export { ComputerControlCapability, ComputerObserveCapability, computerTools } from '../impl/ComputerTools.js'
export type { ComputerToolCapabilitySchema } from '../types/tool.js'
