import type { ModelMessage } from 'ai'

import { isArray, isEmpty, isRecord, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AgentModelInputModality } from '../../types/agent.js'
import { DefaultModelInputModalities } from '../tools/model-input-policy'

/**
 * 由 MIME 串反推输入模态：`image/*` → `'image'`，`audio/*` → `'audio'`，其余（含非字符串、
 * `application/pdf` 这类文件）返回 undefined。判不出模态不等于没有附件，只是不计入模态门的要求。
 */
function mediaTypeModality(value: unknown): AgentModelInputModality | undefined {
  if (!isString(value)) return undefined
  if (value.startsWith('image/')) return 'image'
  if (value.startsWith('audio/')) return 'audio'
  return undefined
}

/**
 * 扫描将要发给供应商的消息，列出这批请求真正用到的输入模态。`'text'` 恒在集合里做基线；
 * 图像/音频靠 part 的 `type`（image/audio/*-data）或 `mediaType` 前缀认出来——所以 `file`、`media`
 * 这类通用块也会按 mediaType 归模态。除消息顶层 part 外，还会下钻 `tool-result` 的
 * `output.type === 'content'` 数组，把工具结果里提上来的媒体块一并算上。返回去重后的模态数组。
 */
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
 * 发往供应商前的最后一道模态门：把这批消息实际需要的模态与模型声明支持的模态相减，有缺口就抛
 * `VALIDATION` AppError，错误文案点名模型与缺的模态并建议换模型，context 里带上
 * model / missingInputModalities / supportedInputModalities 供上层展示。
 * `supportedInputModalities` 没传时按 `DefaultModelInputModalities` 算。
 * 能力发现只能挡住新产生的不兼容工具结果，用户附件和恢复出来的历史消息只有这道门能挡。
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
