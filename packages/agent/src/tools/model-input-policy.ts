import type { AgentModelInputModality } from '@velaros-ai/agent/protocol'

interface ToolModelInputRequirements {
  requiredModelInputModalities?: readonly AgentModelInputModality[]
}

interface ToolModelInputContext {
  getSupportedModelInputModalities?: () => readonly AgentModelInputModality[]
}

const DefaultModelInputModalities = ['text'] as const satisfies readonly AgentModelInputModality[]

/**
 * 判断一个工具产生的模型输入是否能被本轮实际模型消费。
 *
 * 模型能力没有注入时按 text-only 处理，避免旧宿主或不完整测试上下文把图片/音频工具
 * 暴露给无法声明接收这些输入的 provider。
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
