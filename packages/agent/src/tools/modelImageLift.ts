import type { ToolResultModelContentPart } from '@velaros-ai/agent/protocol'
import { isArray, isBlank, isEmpty, isString, toOptional } from '@velaros-ai/core'
import { isRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { ToolResult } from './Executor'

/** A tool can use this envelope when its ordinary result is not itself an object. */
export interface ToolResultModelContentEnvelope {
  result: unknown
  modelContent: readonly ToolResultModelContentPart[]
}

export function withToolResultModelContent(
  result: unknown,
  modelContent: readonly ToolResultModelContentPart[]
): ToolResultModelContentEnvelope {
  return { result, modelContent }
}

function normalizeModelContentPart(value: unknown): Nullable<ToolResultModelContentPart> {
  if (!isRecord(value)) return null

  if (value.type === 'text') {
    if (!isString(value.text) || isBlank(value.text)) return null
    return { type: 'text', text: value.text }
  }

  if (value.type !== 'image-data' && value.type !== 'file-data') return null
  if (!isString(value.data) || isBlank(value.data)) return null
  if (!isString(value.mediaType) || isBlank(value.mediaType)) return null
  if (value.type === 'image-data' && !value.mediaType.toLowerCase().startsWith('image/')) return null

  if (value.type === 'image-data')
    return { type: 'image-data', data: value.data, mediaType: value.mediaType }

  const filename = isString(value.filename) && !isBlank(value.filename)
    ? value.filename
    : undefined
  return {
    type: 'file-data',
    data: value.data,
    mediaType: value.mediaType,
    filename: toOptional(filename),
  }
}

function normalizeModelContent(value: unknown): ToolResultModelContentPart[] {
  if (!isArray(value)) return []
  const parts: ToolResultModelContentPart[] = []
  for (const item of value) {
    const part = normalizeModelContentPart(item)
    if (part) parts.push(part)
  }
  return parts
}

function readLegacyModelImage(value: unknown): Nullable<ToolResult['modelImage']> {
  if (!isRecord(value)) return null
  const data = value.data
  const mediaType = value.mediaType
  if (!isString(data) || isBlank(data)) return null
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') return null
  return { data, mediaType }
}

function includesLegacyImage(
  content: readonly ToolResultModelContentPart[],
  image: NonNullable<ToolResult['modelImage']>
): boolean {
  return content.some((part) =>
    part.type === 'image-data' &&
    part.data === image.data &&
    part.mediaType === image.mediaType
  )
}

/**
 * 通用「模型可见内容」提升。
 *
 * 约定：工具可返回 `{ result, modelContent }` 信封，或在普通对象上附加 `modelContent`。
 * 内容块会从普通结果里剥离，避免把巨大的 base64 当 JSON 文本塞进上下文。旧的
 * `modelImage: { data, mediaType }` 仍可使用，并会自动投影成单个 `image-data` 块。
 *
 * Capability middleware may attach content before this helper runs; those blocks stay first and
 * output-owned blocks are appended in their original order.
 */
export function liftGenericModelContent(result: ToolResult, rawOutput: unknown): ToolResult {
  const attachedContent = normalizeModelContent(result.modelContent)
  let modelContent = attachedContent
  let modelImage = result.modelImage
  let nextResult = result.result
  if (modelImage && !includesLegacyImage(modelContent, modelImage)) {
    modelContent = [
      ...modelContent,
      { type: 'image-data', data: modelImage.data, mediaType: modelImage.mediaType },
    ]
  }

  if (isRecord(rawOutput)) {
    const outputContent = normalizeModelContent(rawOutput.modelContent)
    const outputImage = readLegacyModelImage(rawOutput.modelImage)
    const hasOutputContent = isArray(rawOutput.modelContent)
    const hasOutputImage = !!outputImage

    if (hasOutputContent || hasOutputImage) {
      modelContent = [...modelContent, ...outputContent]
      if (outputImage && !includesLegacyImage(modelContent, outputImage)) {
        modelContent = [
          ...modelContent,
          { type: 'image-data', data: outputImage.data, mediaType: outputImage.mediaType },
        ]
      }
      if (!modelImage && outputImage) modelImage = outputImage

      const isContentEnvelope = hasOutputContent &&
        Object.keys(rawOutput).every((key) =>
          key === 'result' || key === 'modelContent' || key === 'modelImage'
        ) &&
        Object.prototype.hasOwnProperty.call(rawOutput, 'result')
      if (isContentEnvelope) {
        nextResult = rawOutput.result
      } else {
        nextResult = Object.fromEntries(
          Object.entries(rawOutput).filter(([key]) =>
            !(key === 'modelContent' && hasOutputContent) &&
            !(key === 'modelImage' && hasOutputImage)
          )
        )
      }
    }
  }

  if (!modelImage) {
    const firstCompatibleImage = modelContent.find((part) =>
      part.type === 'image-data' &&
      (part.mediaType === 'image/png' || part.mediaType === 'image/jpeg')
    )
    if (firstCompatibleImage?.type === 'image-data') {
      modelImage = {
        data: firstCompatibleImage.data,
        mediaType: firstCompatibleImage.mediaType as 'image/png' | 'image/jpeg',
      }
    }
  }

  if (modelImage && !includesLegacyImage(modelContent, modelImage)) {
    modelContent = [
      ...modelContent,
      { type: 'image-data', data: modelImage.data, mediaType: modelImage.mediaType },
    ]
  }

  return {
    ...result,
    result: nextResult,
    modelContent: toOptional(!isEmpty(modelContent) ? modelContent : null),
    modelImage: toOptional(modelImage),
  }
}

export { liftGenericModelContent as liftGenericModelImage }
