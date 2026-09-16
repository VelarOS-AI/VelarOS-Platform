import { isFiniteNumber, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { fitProjectReadsForModel, hasProjectSourceWindows } from './project-read-serialization'
import { ModelToolResultMaxSerializedLength } from './tool-result-serialization'

export // 当轮句柄化阈值：低于此值的新鲜结果原样直达模型（模型档序列化预算 32K,见
// toolResultSerialization.ts）。曾为 12_000——比模型档预算还小,导致 12.8K 的目录列表
// 当轮变存根、再被下游对半砍成 ~4K 头尾拼接,模型三连 recall 也补不齐（真机 9 轮空转取证）。
// 保持略低于模型档预算,让超大结果走「摘要+可召回句柄」而非盲目对半砍。
const DefaultProjectionChars = 24_000

export const ProjectionTruncationMarker = '...'

export function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

export function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

export function normalizeProjectionChars(value: LooseOptional<number>): number {
  const candidate = value ?? DefaultProjectionChars
  if (!isFiniteNumber(candidate)) return DefaultProjectionChars
  return Math.max(0, Math.floor(candidate))
}

export function sliceHeadOnCharacterBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''

  let end = Math.min(text.length, maxChars)
  if (
    end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1
  }

  return text.slice(0, end)
}

export function sliceTailOnCharacterBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''

  let start = Math.max(0, text.length - maxChars)
  if (
    start > 0 &&
    start < text.length &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    start += 1
  }

  return text.slice(start)
}

export function projectSerializedPreview(serialized: string, projectionChars: number): string {
  if (projectionChars <= 0) return ''
  if (serialized.length <= projectionChars) return serialized
  if (projectionChars <= ProjectionTruncationMarker.length) return sliceHeadOnCharacterBoundary(serialized, projectionChars)

  const available = projectionChars - ProjectionTruncationMarker.length
  const headChars = Math.ceil(available / 2)
  const tailChars = Math.floor(available / 2)
  return `${sliceHeadOnCharacterBoundary(
    serialized,
    headChars
  )}${ProjectionTruncationMarker}${sliceTailOnCharacterBoundary(serialized, tailChars)}`
}

/**
 * 源码窗口结果按整行分页收进预算，输出仍是完整结构；完整输出由调用方照常归档，模型沿窗口自带的
 * continuation 续读。窗口很多时每个窗口的固定元数据（路径、版本、引用、续读）可能让页出预算装不下，
 * 此时退到模型档序列化预算：结构化结果在那一档仍会按行裁剪，比头尾拼接的残片有用得多。两档都装不下
 * 才走普通句柄化。
 */
export function fitSourceWindowsWithinProjection(
  output: unknown,
  projectionChars: number
): Nullable<{ output: unknown; serialized: string }> {
  if (!hasProjectSourceWindows(output)) return null
  for (const budget of [projectionChars, Math.max(projectionChars, ModelToolResultMaxSerializedLength)]) {
    const fitted = fitProjectReadsForModel(output, budget)
    const serialized = serializeOutput(fitted)
    if (serialized.length <= budget) return { output: fitted, serialized }
  }
  return null
}

export function serializeOutput(output: unknown): string {
  if (isString(output)) return output

  try {
    return JSON.stringify(output) ?? 'null'
  } catch (error) {
    return JSON.stringify({
      error: 'tool_output_serialization_failed',
      reason: AppError.getMessage(error),
    })
  }
}
