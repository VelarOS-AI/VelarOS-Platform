import { isArray, isBoolean, isFiniteNumber, isNumber, isPlainObject, isPresent, isString } from '@velaros-ai/core'
import { mapDefined } from '@velaros-ai/core/utils/mapDefined'
import { clamp } from '@velaros-ai/core/utils/number'

import { resolveUsableContextWindow } from './contextBudget'
import { countTokensTiktoken, resolveTokenizerEngine } from './tokenizer'

export interface ContextUsageEstimate {
  estimatedTokens: number
  estimatedChars: number
  contextWindow: number
  /** 扣除输出预留与安全余量后的可用窗口；未启用预算调优时等于 contextWindow。 */
  usableContextWindow: number
  /** 本次计量采用的输出预留 token 数（未启用时为 0）。 */
  reservedOutputTokens: number
  tokenPercent: number
  payloadPercent: number
  percent: number
}

export interface EstimateContextUsageOptions {
  contextWindow?: LooseOptional<number>
  extraContext?: unknown
  extraEstimatedTokens?: LooseOptional<number>
  extraEstimatedChars?: LooseOptional<number>
  /**
   * 为模型本轮输出预留的 token 数；提供后 tokenPercent 改对“可用窗口”计量。
   * 不提供时退化为旧行为（usable == contextWindow），保持向后兼容。
   */
  reservedOutputTokens?: LooseOptional<number>
  /** 安全余量百分比，吸收本地估算与供应方计费口径偏差；与 reservedOutputTokens 同为可选。 */
  safetyMarginPercent?: LooseOptional<number>
  /**
   * MMU 校准系数：由 ContextUsageCalibrator 依据“估算↔真实”残差学习得到，
   * 乘到 estimatedTokens 上以贴近供应方真实输入用量。缺省/非法时按 1 处理。
   */
  calibrationFactor?: LooseOptional<number>
}

// 高水位:指示器 warning 色调与 pipeline 高水位阶段的阈值。手动压缩功能已移除
// (2026-07-18 用户裁决:压缩由内部看门自治),不存在"手动压缩门槛"这一概念。
export const ContextUsageHighWatermarkPercent = 50
export const ContextUsageSemanticPreSummaryPercent = 75
export const ContextUsageCompactionPercent = 80
export const ContextUsagePayloadCompactionChars = 400_000

const ContextUsagePayloadWindowChars = Math.ceil(
  ContextUsagePayloadCompactionChars / (ContextUsageCompactionPercent / 100),
)

const ObjectBoundaryTokenCost = 2
const ArrayBoundaryTokenCost = 2
const PropertyOverheadTokenCost = 1
const MessageBaseTokenCost = 4
const TextPartBaseTokenCost = 3
const FilePartBaseTokenCost = 18
const ToolPartBaseTokenCost = 8
const UnknownCycleTokenCost = 8
const NewlineTokenCost = 0.25
const TabTokenCost = 0.25
const AsciiPunctuationTokenCost = 0.5
const NonAsciiPunctuationTokenCost = 0.75
const EmojiTokenCost = 2
const CjkTokenCost = 1
const OtherUnicodeTokenCost = 1

function summarizeBase64(data: string): string {
  return `[base64 ${Math.ceil((data.length * 3) / 4)} bytes]`
}

function summarizeBinaryValue(value: unknown): unknown {
  if (isString(value)) return summarizeBase64(value)

  if (value instanceof URL) return value.toString()

  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`

  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`

  return value
}

function sanitizeContextValue(value: unknown): unknown {
  if (isArray(value)) return value.map((entry) => sanitizeContextValue(entry))

  if (!value || !isPlainObject(value)) return value

  const record = value
  if (record.type === 'image' && isPresent(record.image)) return {
      ...record,
      image: summarizeBinaryValue(record.image),
    }

  if (record.type === 'file' && isPresent(record.data)) return {
      ...record,
      data: summarizeBinaryValue(record.data),
    }

  // 工具结果里的二进制内容块（截图走 image-data）：不摘要的话一张截图的 base64
  // 会被当普通文本计税（曾把 166KB 模型图记成 ~5.5 万 token，直接压穿治理水位
  // 触发连环压缩）。供应方对图片按视觉口径计费，远低于字符口径。
  if (
    (record.type === 'image-data' || record.type === 'media' || record.type === 'file-data')
    && isPresent(record.data)
  ) return {
      ...record,
      data: summarizeBinaryValue(record.data),
    }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (key === 'imageAttachments' && isArray(entry)) return [
          key,
          entry.map((attachment) => {
            if (!attachment || !isPlainObject(attachment)) return attachment

            const attachmentRecord = attachment
            return {
              ...attachmentRecord,
              data: summarizeBinaryValue(attachmentRecord.data),
            }
          }),
        ]

      return [key, sanitizeContextValue(entry)]
    })
  )
}

function isAsciiWhitespace(charCode: number): boolean {
  return charCode === 0x20 || charCode === 0x09 || charCode === 0x0a || charCode === 0x0d
}

function isAsciiAlphaNumeric(charCode: number): boolean {
  return (
    (charCode >= 0x30 && charCode <= 0x39)
    || (charCode >= 0x41 && charCode <= 0x5a)
    || (charCode >= 0x61 && charCode <= 0x7a)
  )
}

function isAsciiPunctuation(charCode: number): boolean {
  return charCode <= 0x7f && !isAsciiWhitespace(charCode) && !isAsciiAlphaNumeric(charCode)
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x3040 && codePoint <= 0x309f)
    || (codePoint >= 0x30a0 && codePoint <= 0x30ff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
  )
}

function isEmojiCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x2600 && codePoint <= 0x27bf)
  )
}

function isUnicodePunctuation(char: string): boolean {
  return /[\p{P}\p{S}]/u.test(char)
}

function estimateAsciiRunTokens(run: string): number {
  if (!run) return 0

  const segments = run.split(/[^A-Za-z0-9]+/u).filter(Boolean)
  let punctuationCount = 0

  for (let index = 0; index < run.length; index += 1) {
    if (isAsciiPunctuation(run.charCodeAt(index))) {
      punctuationCount += 1
    }
  }

  const alphaNumericTokens = segments.reduce(
    (total, segment) => total + Math.ceil(segment.length / 4),
    0,
  )

  return alphaNumericTokens + (punctuationCount * AsciiPunctuationTokenCost)
}

function looksLikeStructuredText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false

  return (
    ((trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']')))
    || /":\s*(?:\[|\{|")/u.test(trimmed)
    || /[{[\]}]/u.test(trimmed) && /:\s*/u.test(trimmed)
  )
}

function estimateStringTokens(text: string): number {
  if (!text) return 0

  let estimated = 0
  let asciiRun = ''

  const flushAsciiRun = (): void => {
    if (!asciiRun) return

    estimated += estimateAsciiRunTokens(asciiRun)
    asciiRun = ''
  }

  for (const char of text) {
    const codePoint = char.codePointAt(0)
    if (!isNumber(codePoint)) {
      continue
    }

    if (codePoint <= 0x7f) {
      if (isAsciiWhitespace(codePoint)) {
        flushAsciiRun()
        if (char === '\n' || char === '\r') {
          estimated += NewlineTokenCost
        } else if (char === '\t') {
          estimated += TabTokenCost
        }
        continue
      }

      asciiRun += char
      continue
    }

    flushAsciiRun()

    if (isCjkCodePoint(codePoint)) {
      estimated += CjkTokenCost
      continue
    }

    if (isEmojiCodePoint(codePoint)) {
      estimated += EmojiTokenCost
      continue
    }

    estimated += isUnicodePunctuation(char)
      ? NonAsciiPunctuationTokenCost
      : OtherUnicodeTokenCost
  }

  flushAsciiRun()

  const conservativeStructuredEstimate = looksLikeStructuredText(text)
    ? Math.ceil(text.trim().length / 3.5)
    : 0

  return Math.max(1, Math.ceil(Math.max(estimated, conservativeStructuredEstimate)))
}

function isModelMessageLike(value: unknown): value is { role: string; content: unknown } {
  if (!isPlainObject(value) || !isPresent(value)) return false

  const record = value
  return isString(record.role) && isPresent(record.content)
}

function estimateEntriesTokens(
  entries: Array<[string, unknown]>,
  seen: Set<object>,
): number {
  return entries.reduce(
    (total, [key, entry]) =>
      total
      + estimateStringTokens(key)
      + PropertyOverheadTokenCost
      + estimateValueTokens(entry, seen),
    ObjectBoundaryTokenCost,
  )
}

function estimateMessageTokens(
  value: { role: string; content: unknown },
  seen: Set<object>,
): number {
  return (
    MessageBaseTokenCost
    + estimateStringTokens(value.role)
    + estimateValueTokens(value.content, seen)
  )
}

function estimateTypedPartTokens(
  value: Record<string, unknown>,
  seen: Set<object>,
): number {
  const type = isString(value.type) ? value.type : ''
  switch (type) {
    case 'text':
      return (
        TextPartBaseTokenCost
        + estimateStringTokens(String(value.text ?? ''))
        + estimateValueTokens(value.value, seen)
      )
    case 'image':
      return (
        FilePartBaseTokenCost
        + estimateStringTokens(String(value.image ?? ''))
        + estimateStringTokens(String(value.mediaType ?? ''))
      )
    case 'file':
      return (
        FilePartBaseTokenCost
        + estimateStringTokens(String(value.data ?? ''))
        + estimateStringTokens(String(value.mediaType ?? ''))
      )
    case 'tool-call':
      return (
        ToolPartBaseTokenCost
        + estimateStringTokens(String(value.toolName ?? ''))
        + estimateStringTokens(String(value.toolCallId ?? ''))
        + estimateValueTokens(value.input, seen)
      )
    case 'tool-result':
      return (
        ToolPartBaseTokenCost
        + estimateStringTokens(String(value.toolName ?? ''))
        + estimateStringTokens(String(value.toolCallId ?? ''))
        + estimateValueTokens(value.output, seen)
      )
    default:
      return estimateEntriesTokens(Object.entries(value), seen)
  }
}

function estimateValueTokens(value: unknown, seen: Set<object>): number {
  if (isString(value)) return estimateStringTokens(value)

  if (isNumber(value)) return estimateStringTokens(String(value))

  if (isBoolean(value)) return 1

  if (!isPresent(value)) return 1

  if (value instanceof URL) return estimateStringTokens(value.toString())

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return estimateStringTokens(String(summarizeBinaryValue(value)))

  if (isArray(value)) return value.reduce<number>(
      (total, entry) => total + estimateValueTokens(entry, seen),
      ArrayBoundaryTokenCost,
    )

  if (!isPlainObject(value)) return estimateStringTokens(String(value))

  if (seen.has(value)) return UnknownCycleTokenCost

  seen.add(value)

  if (isModelMessageLike(value)) return estimateMessageTokens(value, seen)

  const record = value
  if (isString(record.type)) return estimateTypedPartTokens(record, seen)

  return estimateEntriesTokens(Object.entries(record), seen)
}

export function estimateContextUsage(
  model: string,
  systemPrompt: string,
  history: unknown,
  options: EstimateContextUsageOptions = {}
): ContextUsageEstimate {
  const sanitizedHistory = sanitizeContextValue(history)
  const sanitizedExtraContext = mapDefined(options.extraContext, sanitizeContextValue)
  const contextPayload =
    !isPresent(sanitizedExtraContext)
      ? {
          systemPrompt,
          history: sanitizedHistory,
        }
      : {
          systemPrompt,
          history: sanitizedHistory,
          extraContext: sanitizedExtraContext,
        }
  const serializedPayload = JSON.stringify(contextPayload) ?? ''
  const extraEstimatedTokens = Math.max(0, Math.ceil(options.extraEstimatedTokens ?? 0))
  const extraEstimatedChars = Math.max(0, Math.ceil(options.extraEstimatedChars ?? 0))
  const estimatedChars = serializedPayload.length + extraEstimatedChars
  const engine = resolveTokenizerEngine()
  let estimatedTokens = 0

  try {
    if (engine === 'tiktoken') {
      // 直接在序列化后的 JSON 上跑 BPE：包含了 role/content/tool-call 等 JSON 包装的真实 token 成本，
      // 与上游 AI provider 计费口径最接近；不再额外加 MessageBase/PartBase 这类启发式常量。
      estimatedTokens = Math.max(1, countTokensTiktoken(serializedPayload) + extraEstimatedTokens)
    } else {
      estimatedTokens = Math.max(
        1,
        Math.ceil(
          estimateValueTokens(contextPayload, new Set<object>()) + extraEstimatedTokens
        ),
      )
    }
  } catch {
    // arch-guard:silent-catch-ok Token estimation falls back to a deterministic char heuristic.
    estimatedTokens = Math.ceil(estimatedChars / 4)
  }

  // MMU 校准：把“估算→真实”学到的残差系数乘进估算值，使其贴近供应方真实输入用量。
  const calibrationFactor = options.calibrationFactor
  if (isFiniteNumber(calibrationFactor) && calibrationFactor > 0) {
    estimatedTokens = Math.max(1, Math.ceil(estimatedTokens * calibrationFactor))
  }

  const contextWindow = isFiniteNumber(options.contextWindow)
      ? Math.max(1, Math.floor(options.contextWindow))
      : 128_000
  // 水位一律按模型真实窗口百分比计；请求体积由注意力路由、压缩与回收阶梯独立约束。
  // 预算调优为可选项：仅当调用方提供输出预留/安全余量时，才把百分比改对“可用窗口”计量；
  // 否则退化为旧行为（usable == contextWindow），保证既有调用与测试不变。
  const hasBudgetTuning =
    isFiniteNumber(options.reservedOutputTokens) || isFiniteNumber(options.safetyMarginPercent)
  const reservedOutputTokens = hasBudgetTuning
    ? Math.max(0, Math.floor(options.reservedOutputTokens ?? 0))
    : 0
  const safetyMarginPercent = hasBudgetTuning
    ? clamp((options.safetyMarginPercent ?? 0), 0, 90)
    : 0
  const usableContextWindow = hasBudgetTuning
    ? resolveUsableContextWindow({ contextWindow, reservedOutputTokens, safetyMarginPercent })
    : contextWindow
  const tokenPercent = Number(((estimatedTokens / usableContextWindow) * 100).toFixed(2))
  const payloadPercent = Number(
    ((estimatedChars / ContextUsagePayloadWindowChars) * 100).toFixed(2)
  )
  const percent = tokenPercent

  return {
    estimatedTokens,
    estimatedChars,
    contextWindow,
    usableContextWindow,
    reservedOutputTokens,
    tokenPercent,
    payloadPercent,
    percent,
  }
}
