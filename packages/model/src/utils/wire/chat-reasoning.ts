import { ReasoningLevels } from '../../contract/constants'
import type { ChatProviderId, ReasoningLevel } from '../../types/model'

import { fitReasoningLevel, resolveReasoningBudget } from './reasoning'

/** 看起来是推理型号的名字：这些型号走 Chat Completions 时带 `reasoning_effort`。 */
const ReasoningModelPattern =
  /(?:^|\/)(?:o[134](?:-|$)|gpt-5|gpt-oss|claude|gemini-(?:2\.5|3)|deepseek|qwen3|qwq|grok|kimi|glm-[45]|doubao-seed)/i

/**
 * 走 Chat Completions 的供应商这一档要写进请求体的思考参数；这一档什么都不写时返回 null。
 *
 * 通义（DashScope）用 `enable_thinking` + `thinking_budget`；DeepSeek 只认 high / max，低于 high 不写，交给
 * 型号默认；其余供应商（兼容网关、Grok、Kimi、智谱、本地服务等）按型号名认出推理型号后写
 * `reasoning_effort`，按型号退到它支持的最高档。不求每家都精确：写错了会被拒，由调用处往下退档重发。
 */
export function chatReasoningFields(
  provider: ChatProviderId,
  model: string,
  level: ReasoningLevel,
  maxOutputTokens?: number
): Nullable<Record<string, unknown>> {
  switch (provider) {
    case 'qwen':
      return {
        enable_thinking: true,
        thinking_budget: resolveReasoningBudget(maxOutputTokens, level),
      }
    case 'deepseek':
      return ReasoningLevels.indexOf(level) < ReasoningLevels.indexOf('high')
        ? null
        : { reasoning_effort: level === 'high' ? 'high' : 'max' }
    default:
      return ReasoningModelPattern.test(model)
        ? { reasoning_effort: fitReasoningLevel(level, model) }
        : null
  }
}
