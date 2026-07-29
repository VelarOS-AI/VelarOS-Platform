import { isBlank } from '@velaros-ai/core'
import { isRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { ToolResult } from './Executor'

/**
 * 通用「模型可见图片」提升。
 *
 * 约定：任何工具只要在返回结果里带上 `modelImage: { data, mediaType }`，就会被提升成
 * 模型可见的图片内容块，并从文本结果里剥离（避免把巨大的 base64 当文本塞进上下文）。
 *
 * Capability middleware may attach richer opaque artifact metadata. This helper keeps an
 * already-attached modelImage intact and otherwise lifts the common data/mediaType shape.
 */
export function liftGenericModelImage(result: ToolResult, rawOutput: unknown): ToolResult {
  if (result.modelImage) return result
  if (!isRecord(rawOutput)) return result

  const candidate = rawOutput.modelImage
  if (!isRecord(candidate)) return result

  const data = candidate.data
  const mediaType = candidate.mediaType
  if (typeof data !== 'string' || isBlank(data)) return result
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') return result

  // 把 modelImage 从文本面结果里剥掉，只保留元数据；图片走 image 内容块。
  const { modelImage: _omitted, ...rest } = rawOutput
  return { ...result, result: rest, modelImage: { data, mediaType } }
}
