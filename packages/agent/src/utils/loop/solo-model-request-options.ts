import { isFiniteNumber } from '@velaros-ai/core'

import type { AgentExecutionConfig,AgentModelRequestOptions } from '../../contract/requires.js'
import { AgentTuning } from '../tuning'

/**
 * HTML 实时预览会在单条回复中连续输出完整 HTML/CSS/JS；普通 compact 的 8k 输出预算
 * 很容易在闭合协议前被截断。只在用户明确开启该能力时提高下限，其他聊天继续遵守原档位。
 * 值在 `AgentTuning.loop.htmlArtifactMinimumOutputTokens`。
 */
const HtmlArtifactMinimumOutputTokens = AgentTuning.loop.htmlArtifactMinimumOutputTokens

/**
 * 只在用户开了 `html-artifact` 能力时抬高这一轮的输出 token 下限：没开这个能力、或现有上限本就已达
 * `HtmlArtifactMinimumOutputTokens`（24k），就把 options 原样放行；否则复制一份把
 * `requestPolicy.maxOutputTokens` 顶到 24k。抬的是下限不是定值——宿主配得更高的照样保留。
 */
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
