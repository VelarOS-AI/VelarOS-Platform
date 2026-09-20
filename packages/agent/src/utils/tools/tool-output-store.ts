import { isFiniteNumber, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ContextPayloadRecord } from '../../types/context.js'
import type { KernelStoredToolOutput, ProjectKernelToolOutputInput } from '../../types/tools.js'
import { AgentTuning } from '../tuning'

import { fitProjectReadsForModel, hasProjectSourceWindows } from './project-read-serialization'
import { ModelToolResultMaxSerializedLength } from './tool-result-serialization'

export const ProjectionTruncationMarker = '...'

/**
 * 该 UTF-16 码元是否为高代理项（0xD800–0xDBFF），即一个星外字符（emoji 等）的前半个码元。
 * 头尾截断靠它判断刀口会不会把一个字符劈成两半。
 */
export function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

/**
 * 该 UTF-16 码元是否为低代理项（0xDC00–0xDFFF），即一个星外字符的后半个码元。与 isHighSurrogate 成对，供截断避开半个字符。
 */
export function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

/**
 * 把调用方给的当轮投影字符预算收敛成合法值：缺省或非有限数（NaN/Infinity）一律回落到
 * `AgentTuning.tools.outputProjectionChars`，其余向下取整并夹到不小于 0（传 0 即「全部句柄化，正文一个字都不直达模型」）。
 *
 * 这条缺省是**当轮句柄化阈值**：低于它的新鲜结果原样直达模型。曾为 12_000——比模型档序列化预算还小，
 * 导致 12.8K 的目录列表当轮变存根、再被下游对半砍成 ~4K 头尾拼接，模型三连 recall 也补不齐（真机 9 轮空转取证）。
 * 保持略低于模型档预算，让超大结果走「摘要+可召回句柄」而非盲目对半砍。
 */
export function normalizeProjectionChars(value: LooseOptional<number>): number {
  const candidate = value ?? AgentTuning.tools.outputProjectionChars
  if (!isFiniteNumber(candidate)) return AgentTuning.tools.outputProjectionChars
  return Math.max(0, Math.floor(candidate))
}

/**
 * 取前 maxChars 个 UTF-16 码元，但刀口正好落在代理对中间时回退一位，绝不留下半个字符。
 * maxChars ≤ 0 返回空串；文本本来就不长于预算时原样返回。实际长度可能比 maxChars 少 1，这是为避免产出非法串故意付的代价。
 */
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

/**
 * 取末尾 maxChars 个 UTF-16 码元，起点落在代理对中间时向后挪一位，绝不以半个字符开头。
 * maxChars ≤ 0 返回空串；同样可能比 maxChars 少 1 个码元。
 */
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

/**
 * 把已序列化的工具输出压进当轮投影预算：不超预算原样返回，超了就「头 + `...` + 尾」各留一半（头多尾少），两端都按字符边界切。
 * 预算 ≤ 0 返回空串；预算小到连省略号都放不下时只留头部。中段被裁掉的内容不在这里可召回——
 * 完整正文由调用方另行归档，模型要补全得走 历史检索服务 拿句柄。
 */
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

/**
 * 按一条已归档的 payload 记录拼出这次工具输出的存档回执（`KernelStoredToolOutput`）。
 *
 * 地址、哈希、字符数、创建时刻一律以 payload 记录为准，调用方只补会话键与原始输出；
 * `sameAsToolCallId` 只有在这次正文与更早一次完全同文时才写上，缺省时整个键不出现。
 */
export function buildStoredToolOutput(input: {
  input: ProjectKernelToolOutputInput
  sessionId: string
  serialized: string
  record: ContextPayloadRecord
  sameAsToolCallId?: string
}): KernelStoredToolOutput {
  const stored: KernelStoredToolOutput = {
    outputId: input.record.payloadRef,
    payloadRef: input.record.payloadRef,
    hash: input.record.hash,
    sessionId: input.sessionId,
    toolCallId: input.input.toolCallId,
    toolName: input.input.toolName,
    output: input.input.output,
    serialized: input.serialized,
    chars: input.record.chars,
    createdAt: input.record.createdAt,
  }
  if (input.sameAsToolCallId) {
    stored.sameAsToolCallId = input.sameAsToolCallId
  }
  return stored
}

/**
 * 把工具输出序列化成用于归档与投影的字符串：已经是字符串就原样用（不再套一层 JSON 引号），否则 `JSON.stringify`，
 * 返回 undefined 的情况（函数、undefined）记作 `'null'`。
 * 序列化抛错（循环引用、BigInt 等）不往上抛，改吐一条 `{ error: 'tool_output_serialization_failed', reason }` 的 JSON——
 * 归档链路绝不能因为某个工具的返回值不可序列化而整轮失败。
 */
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
