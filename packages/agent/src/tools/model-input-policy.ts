import type { AgentModelInputModality } from '@velaros-ai/agent/protocol'

interface ToolModelInputRequirements {
  requiredModelInputModalities?: readonly AgentModelInputModality[]
}

interface ToolModelInputContext {
  getSupportedModelInputModalities?: () => readonly AgentModelInputModality[]
}

const DefaultModelInputModalities = [
  'text',
  'image',
  'audio',
] as const satisfies readonly AgentModelInputModality[]

/**
 * 判断一个工具产生的模型输入是否能被本轮实际模型消费。
 *
 * 模型能力没有注入时表示“未知”而不是“不支持”：允许 provider 实际尝试，只有模型明确
 * 排除某种输入时才隐藏对应工具，避免把可用的多模态模型误判成纯文本模型。
 */
function isToolCompatibleWithModelInputs(
  tool: ToolModelInputRequirements,
  ctx: ToolModelInputContext
): boolean {
  const supported = new Set(
    ctx.getSupportedModelInputModalities?.() ?? DefaultModelInputModalities
  )
  return (tool.requiredModelInputModalities ?? []).every((modality) => supported.has(modality))
}

export { DefaultModelInputModalities, isToolCompatibleWithModelInputs }
export type { ToolModelInputContext, ToolModelInputRequirements }
