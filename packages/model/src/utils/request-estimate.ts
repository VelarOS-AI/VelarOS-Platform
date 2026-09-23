import { isString } from '@velaros-ai/core'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import type { ModelInputEstimate, ModelTurnRequest } from '../types/driver.js'

import { ModelTuning } from './tuning.js'

/**
 * 按实际发送内容给出不会偏小的输入估算：文本取 UTF-8 字节数（一个 token 至少占一个字节），
 * 图片每张按固定数计。真实用量由调用方用供应商回报校准。
 */
export function estimateRequestInput(request: ModelTurnRequest): ModelInputEstimate {
  const format = modelRequestEncoder.response(request)
  const sent = modelRequestEncoder.messages(request)
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
            part.type === 'image' ? { type: 'image', mediaType: part.mediaType } : part
          ),
        }
  )
  const encoded = JSON.stringify({
    system: request.instructions,
    messages,
    responseFormat: format.type === 'json' ? format : undefined,
  })
  const images = { count, tokens: count * ModelTuning.estimate.imageTokens }
  return {
    tokens: new TextEncoder().encode(encoded).byteLength + images.tokens,
    precision: 'estimate',
    basis: `文本按实际发送内容的 UTF-8 字节保守估算，图片每张按 ${ModelTuning.estimate.imageTokens} token 计；协议误差使用 Agent 的独立余量，非精确 token 计数`,
    images,
  }
}
