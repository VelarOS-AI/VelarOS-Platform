// StreamTurn 用到的纯函数（不碰实例状态）。
import type { ModelMessage } from 'ai'

import { isEmpty, isPositiveNumber } from '@velaros-ai/core'

import { TurnContextFormat } from '../../contract/constants.js'
import type { SystemPromptDelivery } from '../../types/loop.js'
import { createPromptCacheSystemMessage, PromptCacheMinStableSystemChars } from '../model/prompt-cache'

/** dynamic 层尾块。标签固定，正文逐字保留（不重新格式化，否则金标轨迹比对失效）。 */
export function buildDynamicPromptLayerMessage(dynamicPart: string): ModelMessage {
  return {
    role: 'user',
    content: [TurnContextFormat.dynamicLayerMarker, dynamicPart].join('\n'),
  }
}

/**
 * 系统提示词投递（P7-1 的修复点）。
 *
 * 旧形态把 dynamic 层作为**第二条 system 消息插在稳定前缀与历史之间**。那一层里有
 * `runtime.datetime`（`new Date().toLocaleString()`），逐请求变字节 —— 稳定前缀本身还能命中缓存，
 * 但它后面的**整段历史**每一轮都被踢出缓存。在 input:output ≈ 100:1 的 agent 负载上，这是把
 * 最贵的一段反复重算。
 *
 * 新形态：稳定层留在前缀（带缓存断点），dynamic 层整体下沉到活动尾。
 *
 * **为什么尾块是 user 角色而不是 system**：provider 只接受开头连续的 system 段（Anthropic 对被
 * user/assistant 隔开的第二段 system 直接报错）。尾块与既有 retained-context 注入同形——
 * user 角色 + 显式标签，内容仍是原样的 `<current_context>` XML。
 */
export function buildSystemPromptDelivery(
  systemPrompt: string,
  stableCutoff: LooseOptional<number>
): SystemPromptDelivery {
  if (!isPositiveNumber(stableCutoff))
    return { system: systemPrompt, leadingMessages: [], tailBlocks: [] }

  const cutoff = Math.min(Math.floor(stableCutoff), systemPrompt.length)
  const stablePart = systemPrompt.slice(0, cutoff)
  const dynamicPart = systemPrompt.slice(cutoff)

  if (stablePart.length < PromptCacheMinStableSystemChars)
    return { system: systemPrompt, leadingMessages: [], tailBlocks: [] }

  return {
    leadingMessages: [createPromptCacheSystemMessage(stablePart)],
    tailBlocks: isEmpty(dynamicPart.trim()) ? [] : [buildDynamicPromptLayerMessage(dynamicPart)],
  }
}
