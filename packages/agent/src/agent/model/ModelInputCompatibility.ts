import type { ModelMessage } from 'ai'

import type { AgentModelInputModality } from '@velaros-ai/agent/protocol'
import { isArray, isEmpty, isRecord, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { DefaultModelInputModalities } from '../../tools/model-input-policy'

function mediaTypeModality(value: unknown): AgentModelInputModality | undefined {
  if (!isString(value)) return undefined
  if (value.startsWith('image/')) return 'image'
  if (value.startsWith('audio/')) return 'audio'
  return undefined
}

/** Reads the provider-bound message shape, including lifted tool-result media blocks. */
function collectRequiredModelInputModalities(
  messages: readonly ModelMessage[]
): AgentModelInputModality[] {
  const required = new Set<AgentModelInputModality>(['text'])

  const visitMediaPart = (part: unknown): void => {
    if (!isRecord(part)) return
    const type = part.type
    if (type === 'image' || type === 'image-data') required.add('image')
    if (type === 'audio' || type === 'audio-data') required.add('audio')
    if (
      type === 'image' ||
      type === 'image-data' ||
      type === 'audio' ||
      type === 'audio-data' ||
      type === 'file' ||
      type === 'file-data' ||
      type === 'file-url' ||
      type === 'file-id' ||
      type === 'media'
    ) {
      const mediaModality = mediaTypeModality(part.mediaType)
      if (mediaModality) required.add(mediaModality)
    }
  }

  const visitMessagePart = (part: unknown): void => {
    if (!isRecord(part)) return
    visitMediaPart(part)
    if (part.type !== 'tool-result' || !isRecord(part.output)) return
    if (part.output.type !== 'content' || !isArray(part.output.value)) return
    for (const outputPart of part.output.value) visitMediaPart(outputPart)
  }

  for (const message of messages) {
    if (!isArray(message.content)) continue
    for (const part of message.content) visitMessagePart(part)
  }
  return [...required]
}

/**
 * Final provider-send gate. Capability discovery prevents new incompatible tool
 * results; this guard also covers user attachments and restored history.
 */
function assertModelInputCompatibility(input: {
  messages: readonly ModelMessage[]
  supportedInputModalities?: readonly AgentModelInputModality[]
  model: string
}): void {
  const supported = new Set(input.supportedInputModalities ?? DefaultModelInputModalities)
  const missing = collectRequiredModelInputModalities(input.messages).filter(
    (modality) => !supported.has(modality)
  )
  if (isEmpty(missing)) return

  throw new AppError(
    'VALIDATION',
    `当前模型 ${input.model} 未声明支持本次请求所需的输入类型：${missing.join('、')}。请切换到明确支持这些输入的模型后重试。`,
    undefined,
    {
      model: input.model,
      missingInputModalities: missing,
      supportedInputModalities: [...supported],
    }
  )
}

export { assertModelInputCompatibility, collectRequiredModelInputModalities }
