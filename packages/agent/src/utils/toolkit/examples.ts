/** 工具调用示例登记表：本体在 `@velaros-ai/tool-contract`，这里按 agent 沿用的原名转发。 */

export type { ToolExampleRegistryApi as ToolContractExampleRegistry } from '@velaros-ai/tool-contract'
export {
  createToolExampleRegistry,
  toolExamples as DefaultToolContractExampleRegistry,
  renderToolExampleInputs,
  serializeToolExampleInput,
} from '@velaros-ai/tool-contract'
