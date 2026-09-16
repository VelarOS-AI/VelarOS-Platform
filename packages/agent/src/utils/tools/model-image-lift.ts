import { isArray, isBlank, isEmpty, isString, toOptional } from '@velaros-ai/core'
import { isRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { ToolResultModelContentPart } from '../../types/agent'
import type { ToolResult, ToolResultModelContentEnvelope } from '../../types/tools.js'

/**
 * 把工具的原始返回值和要直接给模型看的内容块打成 `{ result, modelContent }` 信封，供 liftGenericModelContent 后续剥离。
 * 这里只做包装，不校验内容块合法性（校验在 normalizeModelContentPart），也不复制数组。
 */
export function withToolResultModelContent(
  result: unknown,
  modelContent: readonly ToolResultModelContentPart[]
): ToolResultModelContentEnvelope {
  return { result, modelContent }
}

/**
 * 校验并收敛单个「模型可见内容块」，任何一项不合规就返回 null（宁可丢这一块，也不让脏数据进模型上下文）。
 * text 块要求 text 是非空白字符串；image-data / file-data 要求 data 与 mediaType 都是非空白字符串，
 * 且 image-data 的 mediaType 必须以 `image/` 开头；file-data 的 filename 是可选的，空白即视为没有。
 * 其它 type 一律不认。
 */
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

/**
 * 把一个来路不明的值收敛成合法内容块数组：不是数组返回空数组，是数组则逐项校验、静默丢掉不合规的项。
 * 只丢坏块不整批拒绝——工具返回里混进一个坏块不该让另外几张图也进不了模型上下文。
 */
function normalizeModelContent(value: unknown): ToolResultModelContentPart[] {
  if (!isArray(value)) return []
  const parts: ToolResultModelContentPart[] = []
  for (const item of value) {
    const part = normalizeModelContentPart(item)
    if (part) parts.push(part)
  }
  return parts
}

/**
 * 读旧式单图字段 `modelImage: { data, mediaType }`，不合规返回 null。
 * data 必须是非空白字符串，mediaType 只认 `image/png` 与 `image/jpeg`——旧字段的契约就这两种，别的格式走新的 modelContent 通道。
 */
function readLegacyModelImage(value: unknown): Nullable<ToolResult['modelImage']> {
  if (!isRecord(value)) return null
  const data = value.data
  const mediaType = value.mediaType
  if (!isString(data) || isBlank(data)) return null
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') return null
  return { data, mediaType }
}

/**
 * 内容块数组里是否已经有一块和这张旧式图完全同源（type 为 image-data 且 data、mediaType 都相等）。
 * 用于去重：旧字段与新内容块往往指同一张图，为真就不要再追加一份，否则同一份 base64 会在模型上下文里出现两次。
 */
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

/**
 * `liftGenericModelContent` 的向后兼容入口，原样转发，语义完全相同。
 * 保留这个旧名是给还按「只提升图片」理解这件事的调用方用的，新代码直接用 liftGenericModelContent。
 */
export function liftGenericModelImage(result: ToolResult, rawOutput: unknown): ToolResult {
  return liftGenericModelContent(result, rawOutput)
}
