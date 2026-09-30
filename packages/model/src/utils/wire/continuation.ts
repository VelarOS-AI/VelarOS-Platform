import type { AssistantModelMessage, LanguageModel, ModelMessage } from 'ai'

import { isArray, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelContinuation, ModelHistoryMessage } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import { markPromptCacheBreakpoints } from './prompt-cache.js'

/** 只有原生 Responses 通道接收此格式，兼容 chat 路由不能接收加密状态。 */
export function usesResponseContinuation(model: LanguageModel): boolean {
  return typeof model !== 'string' && model.provider === 'openai.responses'
}

/** 完整响应按 SDK 原始顺序保存文本、阶段与加密推理；不会保存服务端引用代替正文。 */
export function responseContinuation(
  model: LanguageModel,
  id: string,
  messages: readonly ModelMessage[],
  text: string,
  tokens: number,
  reasoningContext?: unknown
): Optional<ModelContinuation> {
  if (!usesResponseContinuation(model) || typeof model === 'string') return undefined
  const message = messages[0]
  if (messages.length !== 1 || message?.role !== 'assistant' || !isArray(message.content))
    throw new AppError('PROTOCOL', 'Responses 延续状态缺少完整 assistant 响应')
  const content = responseContent(message.content)
  if (responseText(content) !== text)
    throw new AppError('PROTOCOL', 'Responses 延续状态与响应正文不一致')
  return modelRequestEncoder.continuation({
    model: id,
    format: 'openai-responses-v1',
    data: JSON.stringify({
      provider: model.provider,
      model: model.modelId,
      text,
      content,
      ...(isString(reasoningContext) ? { reasoningContext } : {}),
    }),
    tokens,
  })
}

/** 同模型、同路由、原文未改写才恢复状态；其他消息只保留中立正文与缓存标记。 */
export function restoreResponseContinuations(
  messages: readonly ModelHistoryMessage[],
  model: LanguageModel,
  id: string
): { messages: ModelMessage[]; opaqueTokens: number } {
  let opaqueTokens = 0
  const restored = markPromptCacheBreakpoints(messages).map((message, index) => {
    const source = messages[index]!
    const state = source.role === 'assistant' ? source.continuation : undefined
    if (
      !state ||
      state.model !== id ||
      state.format !== 'openai-responses-v1' ||
      !usesResponseContinuation(model) ||
      typeof model === 'string'
    )
      return message
    let data: unknown
    try {
      data = JSON.parse(state.data)
    } catch {
      throw new AppError('VALIDATION', 'Responses 延续状态不是有效 JSON')
    }
    if (!isPlainObject(data)) throw new AppError('VALIDATION', 'Responses 延续状态不是对象')
    if (
      data.provider !== model.provider ||
      data.model !== model.modelId ||
      data.text !== source.content
    )
      return message
    const content = responseContent(data.content)
    if (responseText(content) !== data.text)
      throw new AppError('VALIDATION', 'Responses 延续状态正文被改写')
    opaqueTokens += state.tokens
    return { ...message, role: 'assistant' as const, content }
  })
  return { messages: restored, opaqueTokens }
}

/** ScriptAct 文本协议不允许把工具调用或其他供应商动作藏在延续状态里重放。 */
function responseContent(value: unknown): Exclude<AssistantModelMessage['content'], string> {
  if (
    !isArray(value) ||
    !value.length ||
    value.some(
      (part) =>
        !isPlainObject(part) ||
        !['text', 'reasoning'].includes(String(part.type)) ||
        !isString(part.text) ||
        (part.providerOptions !== undefined && !isPlainObject(part.providerOptions))
    )
  )
    throw new AppError('VALIDATION', 'Responses 延续状态包含非文本响应项')
  return structuredClone(value) as Exclude<AssistantModelMessage['content'], string>
}

/** 文本消息的边界与流式驱动一致：有内容且前段没有换行时补一个换行。 */
function responseText(content: Exclude<AssistantModelMessage['content'], string>): string {
  return content.reduce(
    (text, part) =>
      part.type === 'text' && part.text
        ? text + (text && !text.endsWith('\n') ? '\n' : '') + part.text
        : text,
    ''
  )
}
