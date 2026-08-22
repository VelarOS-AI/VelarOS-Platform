import { isFiniteNumber } from '@velaros-ai/core'

import type { AgentModelRequestOptions } from './model'
import type { AgentExecutionConfig } from './RuntimeConfiguration'

/**
 * HTML 实时预览会在单条回复中连续输出完整 HTML/CSS/JS；普通 compact 的 8k 输出预算
 * 很容易在闭合协议前被截断。只在用户明确开启该能力时提高下限，其他聊天继续遵守原档位。
 */
const HtmlArtifactMinimumOutputTokens = 24_000

function resolveSoloTurnModelRequestOptions(
  options: Optional<AgentModelRequestOptions>,
  promptFeatures: Optional<AgentExecutionConfig['promptFeatures']>
): AgentModelRequestOptions | undefined {
  if (!promptFeatures?.includes('html-artifact')) return options

  const currentMaxOutputTokens = options?.requestPolicy?.maxOutputTokens
  if (
    isFiniteNumber(currentMaxOutputTokens) &&
    currentMaxOutputTokens >= HtmlArtifactMinimumOutputTokens
  ) return options

  return {
    ...(options ?? {}),
    requestPolicy: {
      ...(options?.requestPolicy ?? {}),
      maxOutputTokens: HtmlArtifactMinimumOutputTokens,
    },
  }
}

export { HtmlArtifactMinimumOutputTokens, resolveSoloTurnModelRequestOptions }
