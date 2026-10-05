import type { LanguageModel, ModelMessage } from 'ai'

import { isString } from '@velaros-ai/core'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import type { ModelInputEstimate, ModelTurnRequest } from '../types/driver.js'
import type { ModelTextEncoding } from '../types/requests.js'

import { ModelTuning } from './tuning.js'

/**
 * 计量实际发送内容：默认文本取 UTF-8 字节数，也可由驱动提供校准后的文本计数；
 * 图片与不透明状态独立预留，真实用量继续取供应商回报。
 */
export function estimateRequestInput(
  request: ModelTurnRequest,
  restored?: { messages: readonly ModelMessage[]; opaqueTokens: number },
  textCounter?: (text: string, bytes: number) => number
): ModelInputEstimate {
  const format = modelRequestEncoder.response(request)
  const sent = restored?.messages ?? modelRequestEncoder.messages(request)
  const opaqueTokens = restored?.opaqueTokens ?? 0
  const count = sent.reduce(
    (sum, message) =>
      sum +
      (isString(message.content)
        ? 0
        : message.content.filter((part) => part.type === 'image').length),
    0
  )
  // 图片正文是 base64，字节数与真实开销无关，只留占位
  const messages = sent.map((message) =>
    isString(message.content)
      ? message
      : {
          ...message,
          content: message.content.map((part) =>
            part.type === 'image'
              ? { type: 'image', mediaType: part.mediaType }
              : part.type === 'reasoning'
                ? { type: part.type, text: part.text }
                : part
          ),
        }
  )
  const encoded = JSON.stringify({
    system: request.instructions,
    messages,
    responseFormat: format.type !== 'text' ? format : undefined,
  })
  const bytes = (value: unknown): number =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength
  const composition = {
    unit: 'utf8-bytes' as const,
    system: bytes(request.instructions),
    tools: format.type !== 'text' ? bytes(format) : 0,
    assistantHistory: 0,
    userHistory: 0,
    toolResults: 0,
    current: 0,
    framing: 0,
    total: new TextEncoder().encode(encoded).byteLength,
  }
  for (const [index, message] of messages.entries()) {
    const key =
      index === messages.length - 1
        ? 'current'
        : message.role === 'assistant'
          ? 'assistantHistory'
          : message.role === 'tool'
            ? 'toolResults'
            : 'userHistory'
    composition[key] += bytes(message)
  }
  composition.framing =
    composition.total -
    composition.system -
    composition.tools -
    composition.assistantHistory -
    composition.userHistory -
    composition.toolResults -
    composition.current
  const images = { count, tokens: count * ModelTuning.estimate.imageTokens }
  const estimate: ModelInputEstimate = {
    composition,
    tokens:
      (textCounter?.(encoded, composition.total) ?? composition.total) +
      images.tokens +
      opaqueTokens,
    precision: 'estimate',
    basis: `文本按实际发送内容的 UTF-8 字节保守估算，图片每张按 ${ModelTuning.estimate.imageTokens} token 计；协议误差使用 Agent 的独立余量，非精确 token 计数${opaqueTokens ? '；加密推理状态按原响应的推理用量独立预留，不按密文字符计数' : ''}`,
    images,
  }
  if (opaqueTokens) Object.assign(estimate, { opaqueTokens })
  return estimate
}

/** 路由与型号均已知才用公开编码映射；私有别名与其他供应商继续使用字节估算。 */
export function modelTextEncoding(model: LanguageModel): Optional<ModelTextEncoding> {
  if (isString(model) || !['openai.responses', 'openai.chat'].includes(model.provider))
    return undefined
  const name = model.modelId
  // 映射依据 OpenAI tiktoken/model.py；前缀覆盖该系列的带日期版本。
  if (
    /^(?:gpt-5|gpt-4\.1(?:-|$)|gpt-4\.5-|(?:chat)?gpt-4o(?:-|$)|o1(?:-|$)|o3(?:-|$)|o4-mini(?:-|$))/u.test(
      name
    )
  )
    return 'o200k_base'
  if (/^(?:gpt-4(?:-|$)|gpt-3\.5(?:$|-turbo(?:-|$))|gpt-35-turbo(?:-|$))/u.test(name))
    return 'cl100k_base'
  return undefined
}
