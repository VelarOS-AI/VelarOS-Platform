import type { AssistantModelMessage, JSONValue, LanguageModel, ModelMessage } from 'ai'

import { isArray, isPlainObject, isString, isUndefined, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModelContinuation, ModelHistoryMessage, ModelToolCall } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import { markPromptCacheBreakpoints } from './prompt-cache.js'

/** 只有原生 Responses 通道接收此格式，兼容 chat 路由不能接收加密状态。 */
export function usesResponseContinuation(model: LanguageModel): boolean {
  return !isString(model) && model.provider === 'openai.responses'
}

/** 完整响应按 SDK 原始顺序保存文本、阶段与加密推理；不会保存服务端引用代替正文。 */
export function responseContinuation(
  model: LanguageModel,
  id: string,
  messages: readonly ModelMessage[],
  text: string,
  tokens: number,
  reasoningContext?: unknown,
  calls: readonly ModelToolCall[] = []
): Optional<ModelContinuation> {
  if (!usesResponseContinuation(model) || isString(model)) return undefined
  const message = messages[0]
  if (messages.length !== 1 || message?.role !== 'assistant' || !isArray(message.content))
    throw new AppError('PROTOCOL', 'Responses 延续状态缺少完整 assistant 响应')
  const content = responseContent(message.content, calls)
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
      reasoningContext: optionalWhen(isString, reasoningContext),
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
  const marked = markPromptCacheBreakpoints(messages)
  const restored = marked.flatMap((base, index): ModelMessage[] => {
    const source = messages[index]!
    if (source.role === 'user' && source.toolResult) return []
    const exchange = source.role === 'assistant' ? source.toolExchange : undefined
    const bodies = new Map<string, { content: string; index: number }>()
    if (exchange)
      for (let next = index + 1; next < messages.length; next++) {
        const following = messages[next]!
        if (following.role === 'assistant') break
        if (following.toolResult && isString(following.content))
          bodies.set(following.toolResult.callId, { content: following.content, index: next })
      }
    const breakpoint = [...bodies.values()]
      .reverse()
      .find((item) => messages[item.index]?.cacheBreakpoint)
    let message: ModelMessage = exchange
      ? {
          ...base,
          role: 'assistant',
          content: [
            ...(exchange.text ? [{ type: 'text' as const, text: exchange.text }] : []),
            ...exchange.calls.map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            })),
          ],
        }
      : base
    const result = (): ModelMessage[] =>
      exchange
        ? [
            message,
            {
              role: 'tool',
              ...(breakpoint ? { providerOptions: marked[breakpoint.index]!.providerOptions } : {}),
              content: exchange.results.map((item) => ({
                type: 'tool-result',
                toolCallId: item.id,
                toolName: item.name,
                output: bodies.has(item.id)
                  ? { type: 'text', value: bodies.get(item.id)!.content }
                  : { type: 'json', value: item.output as JSONValue },
              })),
            },
          ]
        : [message]
    const state = source.role === 'assistant' ? source.continuation : undefined
    if (
      !state ||
      state.model !== id ||
      state.format !== 'openai-responses-v1' ||
      !usesResponseContinuation(model) ||
      isString(model)
    )
      return result()
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
      data.text !== (exchange?.text ?? source.content)
    )
      return result()
    const content = responseContent(data.content, exchange?.calls)
    if (responseText(content) !== data.text)
      throw new AppError('VALIDATION', 'Responses 延续状态正文被改写')
    opaqueTokens += state.tokens
    message = { ...message, role: 'assistant' as const, content }
    return result()
  })
  return { messages: restored, opaqueTokens }
}

/** 供应商状态中的调用必须与已接收调用逐一相同；不接受隐藏动作。 */
function responseContent(
  value: unknown,
  calls: readonly ModelToolCall[] = []
): Exclude<AssistantModelMessage['content'], string> {
  if (
    !isArray(value) ||
    !value.length ||
    value.some(
      (part) =>
        !isPlainObject(part) ||
        (!['text', 'reasoning'].includes(String(part.type)) && part.type !== 'tool-call') ||
        (part.type !== 'tool-call' && !isString(part.text)) ||
        (!isUndefined(part.providerOptions) && !isPlainObject(part.providerOptions))
    )
  )
    throw new AppError('VALIDATION', 'Responses 延续状态包含非文本响应项')
  const actions = value.filter(
    (part): part is Record<string, unknown> => isPlainObject(part) && part.type === 'tool-call'
  )
  if (
    actions.length !== calls.length ||
    actions.some((part, index) => {
      const call = calls[index]!
      return (
        part.toolCallId !== call.id ||
        part.toolName !== call.name ||
        part.providerExecuted ||
        JSON.stringify(part.input) !== JSON.stringify(call.input)
      )
    })
  )
    throw new AppError('VALIDATION', 'Responses 延续状态包含未接收的工具调用')
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
