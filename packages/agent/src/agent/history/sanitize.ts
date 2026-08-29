/**
 * 提供方回放前的历史结构清洗；这里不负责压缩。
 *
 * B1 起，工具结果总预算、会话级微压缩和超大用户正文安全阀都迁入上下文治理第二版。预算与降级
 * 统一由驻留账本处理，超大用户正文则由准入层按记录类型处理。
 *
 * 本文件只保留防止会话锁死的结构修复：剥除孤儿工具结果、回填或移除工具调用组、裁剪二进制与
 * 图片、修复非法代理对、剥离提供方私有元数据。该路径必须与压缩策略独立演进。
 */
import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'

import {
  compactToolInputForModel,
  deserializeSerializedToolResult,
  ModelToolResultMaxSerializedLength,
  serializeToolResultForModel,
} from '@velaros-ai/agent'
import { isArray, isBlank, isEmpty, isNonBlankString, isNumber, isPresent, isString,toNullable } from '@velaros-ai/core'
import { isRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

/**
 * 超大 user 正文的全保真层引用（`UserTextPayloadPlanner` 落盘后回填给清洗层，
 * 截断信封才能指向 payloadRef 而不是只留一句"已截断"）。
 *
 * 原住 v1 `history/microCompaction.ts`；该文件随治理 v2 拆除，此形状是
 * {@link SanitizeModelHistoryOptions} 的一部分，跟着清洗层走。
 */
interface UserTextPayloadReference {
  messageIndex: number
  payloadRef: string
  hash: string
  originalChars: number
}

interface ModelHistorySanitizationResult {
  history: ModelMessage[]
  changedMessages: number
}

interface ModelMessageSanitizationResult {
  message: ModelMessage
  changed: boolean
}

interface ModelMessageSanitizationOptions {
  skipToolResultBudget?: boolean
}

interface AssistantToolCallNameCandidate {
  partIndex: number
  toolCallId: string
  toolName: Nullable<string>
}

interface ToolResultNameReference {
  toolCallId: string
  toolName: string
}

interface PositionalToolCallReference {
  messageIndex: number
  partIndex: number
  toolCallId: Nullable<string>
  toolName: Nullable<string>
}

interface PositionalToolResultReference extends PositionalToolCallReference {}

/** `sanitizeModelHistory` 的选项。 */
export interface SanitizeModelHistoryOptions {
  /**
   * 供应方回放前必须替换工具结果正文的工具调用标识。
   * 编码编排器用它避免原始发现阶段输出流入变更、验证和综合阶段。
   */
  /** 已持久化的超大 user 正文 payload 引用，按 messageIndex 索引（准入层的 payloadRef 来源）。 */
  userTextPayloadRefs?: readonly UserTextPayloadReference[]
  /** 已持久化的工具结果 payload 引用，按 toolCallId 或 message/part occurrence key 索引。 */
  toolResultPayloadRefs?: Readonly<Record<string, string>>
  /** 切换供应商/模型回放历史时，移除供应商私有的 part metadata。 */
  stripProviderSpecificMetadata?: boolean
}

const MaxRecentToolResultContentImagesToKeep = 1

const HistoricalImagePlaceholder =
  '[historical image bytes omitted only from this later provider replay; the image may have been visible in its original turn]'
const HistoricalFilePlaceholder =
  '[historical file bytes omitted only from this later provider replay; the file may have been available in its original turn]'
const HistoricalToolImagePlaceholder =
  '[historical tool image bytes omitted only from this later provider replay; it may have been visible in the original tool result; use the artifact reference in this tool result instead]'
const InvalidTextSurrogatePattern =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const EmptyResponseReplayPrefixes = [
  '模型返回了空响应。',
  '模型服务返回了空内容响应',
  '模型服务返回了成功结束的空内容响应',
  'Model returned an empty response.',
  'The model service returned an empty response',
  'The model service returned a successful but empty response',
]

function stringifyForComparison(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    // arch-guard:silent-catch-ok JSON 序列化兜底参与相等性比较，必须保持轻量。
    return String(value)
  }
}

function hasSameProviderPayload(left: unknown, right: unknown): boolean {
  return stringifyForComparison(left) === stringifyForComparison(right)
}

function readToolInputRecord(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : { input }
}

function collapseRepeatedSequence<T>(values: T[], isEqual: (left: T, right: T) => boolean): T[] {
  if (values.length < 2) return values

  for (let length = 1; length <= Math.floor(values.length / 2); length += 1) {
    if (values.length % length !== 0) {
      continue
    }

    let repeated = true
    for (let index = length; index < values.length; index += 1) {
      if (!isEqual(values[index], values[index % length])) {
        repeated = false
        break
      }
    }

    if (repeated) return values.slice(0, length)
  }

  return values
}

function isDisplayOnlyEmptyResponseText(text: string): boolean {
  const trimmed = text.trim()
  return EmptyResponseReplayPrefixes.some((prefix) => trimmed.startsWith(prefix))
}

function readTextLikePart(part: unknown): Nullable<string> {
  if (!isRecord(part)) return null

  const type = part.type
  if ((type === 'text' || type === 'reasoning') && isString(part.text)) return part.text

  if (type === 'thinking' && isString(part.thinking)) return part.thinking

  return null
}

function isToolCallLikePart(part: unknown): boolean {
  return (
    isRecord(part) &&
    (part.type === 'tool-call' || part.type === 'toolCall') &&
    (isNonBlankString(part.toolCallId) || isNonBlankString(part.id)) &&
    (isNonBlankString(part.toolName) || isNonBlankString(part.name))
  )
}

function isToolCallPart(part: unknown): part is ToolCallPart {
  return (
    isRecord(part) &&
    part.type === 'tool-call' &&
    isNonBlankString(part.toolCallId) &&
    isNonBlankString(part.toolName)
  )
}

function isToolResultPart(part: unknown): part is ToolResultPart {
  return (
    isRecord(part) &&
    part.type === 'tool-result' &&
    isNonBlankString(part.toolCallId) &&
    isNonBlankString(part.toolName) &&
    isRecord(part.output)
  )
}

function readNonBlankString(value: unknown): Nullable<string> {
  if (!isString(value)) return null
  const trimmed = value.trim()
  return trimmed || null
}

function readAssistantToolCallNameCandidates(
  message: ModelMessage
): AssistantToolCallNameCandidate[] {
  if (message.role !== 'assistant' || !isArray(message.content)) return []

  const candidates: AssistantToolCallNameCandidate[] = []
  message.content.forEach((part, partIndex) => {
    if (!isRecord(part)) return

    const record = part as Record<string, unknown>
    if (record.type !== 'tool-call') return

    const toolCallId = readNonBlankString(record.toolCallId)
    if (!toolCallId) return

    candidates.push({
      partIndex,
      toolCallId,
      toolName: readNonBlankString(record.toolName),
    })
  })

  return candidates
}

function readToolResultNameReferences(message: ModelMessage): ToolResultNameReference[] {
  if (message.role !== 'tool' || !isArray(message.content)) return []

  const references: ToolResultNameReference[] = []
  message.content.forEach((part) => {
    if (!isRecord(part)) return

    const record = part as Record<string, unknown>
    if (record.type !== 'tool-result') return

    const toolCallId = readNonBlankString(record.toolCallId)
    const toolName = readNonBlankString(record.toolName)
    if (!toolCallId || !toolName) return

    references.push({ toolCallId, toolName })
  })

  return references
}

function readPositionalAssistantToolCalls(
  message: ModelMessage,
  messageIndex: number
): PositionalToolCallReference[] {
  if (message.role !== 'assistant' || !isArray(message.content)) return []

  const references: PositionalToolCallReference[] = []
  message.content.forEach((part, partIndex) => {
    if (!isRecord(part)) return

    const record = part as Record<string, unknown>
    if (record.type !== 'tool-call') return

    references.push({
      messageIndex,
      partIndex,
      toolCallId: readNonBlankString(record.toolCallId),
      toolName: readNonBlankString(record.toolName),
    })
  })

  return references
}

function readPositionalToolResults(
  message: ModelMessage,
  messageIndex: number
): PositionalToolResultReference[] {
  if (message.role !== 'tool' || !isArray(message.content)) return []

  const references: PositionalToolResultReference[] = []
  message.content.forEach((part, partIndex) => {
    if (!isRecord(part)) return

    const record = part as Record<string, unknown>
    if (record.type !== 'tool-result') return

    references.push({
      messageIndex,
      partIndex,
      toolCallId: readNonBlankString(record.toolCallId),
      toolName: readNonBlankString(record.toolName),
    })
  })

  return references
}

function collectFollowingPositionalToolResults(
  history: readonly ModelMessage[],
  assistantIndex: number
): PositionalToolResultReference[] {
  const references: PositionalToolResultReference[] = []
  for (let index = assistantIndex + 1; index < history.length; index += 1) {
    const message = history[index]!
    if (message.role !== 'tool') break

    references.push(...readPositionalToolResults(message, index))
  }

  return references
}

function collectUsedToolCallIds(history: readonly ModelMessage[]): Set<string> {
  const used = new Set<string>()
  for (const message of history) {
    if (!isArray(message.content)) continue

    for (const part of message.content) {
      if (!isRecord(part)) continue
      const record = part as Record<string, unknown>
      if (record.type !== 'tool-call' && record.type !== 'tool-result') continue

      const toolCallId = readNonBlankString(record.toolCallId)
      if (toolCallId) used.add(toolCallId)
    }
  }

  return used
}

function allocateSyntheticHistoryToolCallId(
  usedToolCallIds: Set<string>,
  assistantIndex: number,
  callIndex: number
): string {
  let suffix = 0
  let candidate = `synthetic-history-tool-${assistantIndex}-${callIndex}`
  while (usedToolCallIds.has(candidate)) {
    suffix += 1
    candidate = `synthetic-history-tool-${assistantIndex}-${callIndex}-${suffix}`
  }
  usedToolCallIds.add(candidate)
  return candidate
}

function canRepairBlankToolCallIdPair(
  call: PositionalToolCallReference,
  result: PositionalToolResultReference
): boolean {
  if (call.toolCallId || result.toolCallId) return false
  return !!call.toolName && call.toolName === result.toolName
}

function rewriteToolPartId(
  message: ModelMessage,
  partIndex: number,
  toolCallId: string
): ModelMessage {
  if (!isArray(message.content)) return message

  const content = message.content.map((part, index) => {
    if (index !== partIndex || !isRecord(part)) return part
    return { ...part, toolCallId }
  })

  return {
    ...message,
    content: content as ModelMessage['content'],
  } as ModelMessage
}

function repairBlankToolCallIdsByAdjacentResults(
  history: ModelMessage[]
): ModelHistorySanitizationResult {
  let nextHistory: Nullable<ModelMessage[]> = null
  const changedMessageIndexes = new Set<number>()
  const usedToolCallIds = collectUsedToolCallIds(history)

  history.forEach((message, messageIndex) => {
    const calls = readPositionalAssistantToolCalls(message, messageIndex)
    if (isEmpty(calls) || calls.every((call) => !!call.toolCallId)) return

    const results = collectFollowingPositionalToolResults(history, messageIndex)
    if (calls.length !== results.length) return

    calls.forEach((call, callIndex) => {
      const result = results[callIndex]
      if (!result || !canRepairBlankToolCallIdPair(call, result)) return

      const syntheticId = allocateSyntheticHistoryToolCallId(
        usedToolCallIds,
        messageIndex,
        callIndex
      )
      nextHistory ??= history.slice()
      nextHistory[call.messageIndex] = rewriteToolPartId(
        nextHistory[call.messageIndex]!,
        call.partIndex,
        syntheticId
      )
      nextHistory[result.messageIndex] = rewriteToolPartId(
        nextHistory[result.messageIndex]!,
        result.partIndex,
        syntheticId
      )
      changedMessageIndexes.add(call.messageIndex)
      changedMessageIndexes.add(result.messageIndex)
    })
  })

  return {
    history: nextHistory ?? history,
    changedMessages: changedMessageIndexes.size,
  }
}

function collectFollowingToolResultNameReferences(
  history: readonly ModelMessage[],
  assistantIndex: number
): ToolResultNameReference[] {
  const references: ToolResultNameReference[] = []
  for (let index = assistantIndex + 1; index < history.length; index += 1) {
    const message = history[index]!
    if (message.role !== 'tool') break

    references.push(...readToolResultNameReferences(message))
  }

  return references
}

function hasDistinctNonEmptyToolCallIds(
  calls: readonly AssistantToolCallNameCandidate[]
): boolean {
  const seen = new Set<string>()
  for (const call of calls) {
    if (!call.toolCallId || seen.has(call.toolCallId)) return false
    seen.add(call.toolCallId)
  }

  return seen.size > 0
}

function backfillAssistantToolCallNamesFromResults(
  history: ModelMessage[]
): ModelHistorySanitizationResult {
  let changedMessages = 0
  const nextHistory = history.map((message, messageIndex) => {
    const calls = readAssistantToolCallNameCandidates(message)
    if (isEmpty(calls) || calls.every((call) => !!call.toolName)) return message

    const references = collectFollowingToolResultNameReferences(history, messageIndex)
    if (isEmpty(references) || !isArray(message.content)) return message

    const useIdLookup = hasDistinctNonEmptyToolCallIds(calls)
    const resultNameById = new Map<string, string>()
    references.forEach((reference) => {
      if (!resultNameById.has(reference.toolCallId)) {
        resultNameById.set(reference.toolCallId, reference.toolName)
      }
    })

    let changed = false
    const nextContent = message.content.map((part, partIndex) => {
      const callIndex = calls.findIndex((call) => call.partIndex === partIndex)
      if (callIndex < 0) return part

      const call = calls[callIndex]
      if (call.toolName) return part

      const toolName = useIdLookup
        ? resultNameById.get(call.toolCallId)
        : references[callIndex]?.toolName
      if (!toolName) return part

      changed = true
      return { ...part, toolName }
    })

    if (!changed) return message

    changedMessages += 1
    return {
      ...message,
      content: nextContent as ModelMessage['content'],
    } as ModelMessage
  })

  return {
    history: changedMessages > 0 ? nextHistory : history,
    changedMessages,
  }
}

/** provider 运行时会在消息/片段上私挂的未声明键;泛型剥离用的解析后桥接形状(§12.5)。 */
interface ProviderSpecificMetadataCarrier {
  providerMetadata?: unknown
  callProviderMetadata?: unknown
}

function stripProviderSpecificMetadataRecord<T extends object>(record: T): {
  record: T
  changed: boolean
} {
  const hasProviderMetadata = Object.prototype.hasOwnProperty.call(record, 'providerMetadata')
  const hasCallProviderMetadata = Object.prototype.hasOwnProperty.call(
    record,
    'callProviderMetadata'
  )
  if (!hasProviderMetadata && !hasCallProviderMetadata) return { record, changed: false }

  const {
    providerMetadata: _providerMetadata,
    callProviderMetadata: _callProviderMetadata,
    ...next
  } = record as T & ProviderSpecificMetadataCarrier
  return { record: next as T, changed: true }
}

function readProviderSpecificReasoningText(record: Record<string, unknown>): Nullable<string> {
  if (
    record.type === 'reasoning' &&
    isString(record.text) &&
    !isBlank(record.text.trim())
  ) return record.text

  if (
    record.type === 'thinking' &&
    isString(record.thinking) &&
    !isBlank(record.thinking.trim())
  ) return record.thinking

  return null
}

function stripProviderSpecificMetadataFromMessage(
  message: ModelMessage
): ModelMessageSanitizationResult {
  let changed = false
  let nextMessage = message
  const strippedMessage = stripProviderSpecificMetadataRecord(message)
  if (strippedMessage.changed) {
    nextMessage = strippedMessage.record
    changed = true
  }

  if (!isArray(nextMessage.content)) return { message: nextMessage, changed }

  let contentChanged = false
  const nextContent = nextMessage.content.map((part) => {
    if (!isRecord(part)) return part

    const partRecord = part as Record<string, unknown>
    const reasoningText = readProviderSpecificReasoningText(partRecord)
    if (reasoningText) {
      contentChanged = true
      return { type: 'text', text: reasoningText }
    }

    const strippedPart = stripProviderSpecificMetadataRecord(partRecord)
    if (!strippedPart.changed) return part

    contentChanged = true
    return strippedPart.record
  })

  if (!contentChanged) return { message: nextMessage, changed }

  return {
    message: {
      ...nextMessage,
      content: nextContent as ModelMessage['content'],
    } as ModelMessage,
    changed: true,
  }
}

function stripProviderSpecificMetadataFromHistory(
  history: ModelMessage[]
): ModelHistorySanitizationResult {
  let changedMessages = 0
  const nextHistory = history.map((message) => {
    const result = stripProviderSpecificMetadataFromMessage(message)
    if (result.changed) {
      changedMessages += 1
    }
    return result.message
  })

  return {
    history: changedMessages > 0 ? nextHistory : history,
    changedMessages,
  }
}

function sanitizeInvalidTextSurrogates(value: string): string {
  return value.replace(InvalidTextSurrogatePattern, '\uFFFD')
}

function sanitizeUnknownSurrogates(value: unknown): {
  value: unknown
  changed: boolean
} {
  if (isString(value)) {
    const sanitized = sanitizeInvalidTextSurrogates(value)
    return sanitized === value
      ? { value, changed: false }
      : { value: sanitized, changed: true }
  }

  if (isArray(value)) {
    let changed = false
    const nextValue = value.map((item) => {
      const result = sanitizeUnknownSurrogates(item)
      if (result.changed) {
        changed = true
      }
      return result.value
    })
    return changed
      ? { value: nextValue, changed: true }
      : { value, changed: false }
  }

  if (isRecord(value)) {
    let changed = false
    const entries = Object.entries(value).map(([key, item]) => {
      const result = sanitizeUnknownSurrogates(item)
      if (result.changed) {
        changed = true
      }
      return [key, result.value] as const
    })
    return changed
      ? { value: Object.fromEntries(entries), changed: true }
      : { value, changed: false }
  }

  return { value, changed: false }
}

function sanitizeStringRecordField(
  record: Record<string, unknown>,
  field: string
): Nullable<Record<string, unknown>> {
  const value = record[field]
  if (!isString(value)) return null

  const sanitized = sanitizeInvalidTextSurrogates(value)
  if (sanitized === value) return null

  return { ...record, [field]: sanitized }
}

function sanitizeTextContentPartSurrogates(part: Record<string, unknown>): {
  part: Record<string, unknown>
  changed: boolean
} {
  if (part.type === 'text' || part.type === 'reasoning') {
    const sanitizedPart = sanitizeStringRecordField(part, 'text')
    return sanitizedPart
      ? { part: sanitizedPart, changed: true }
      : { part, changed: false }
  }

  if (part.type === 'thinking') {
    const sanitizedPart = sanitizeStringRecordField(part, 'thinking')
    return sanitizedPart
      ? { part: sanitizedPart, changed: true }
      : { part, changed: false }
  }

  return { part, changed: false }
}

function sanitizeToolResultOutputSurrogates(output: unknown): {
  output: unknown
  changed: boolean
} {
  if (!isRecord(output)) return { output, changed: false }

  if ((output.type === 'text' || output.type === 'error-text') && isString(output.value)) {
    const sanitized = sanitizeInvalidTextSurrogates(output.value)
    return sanitized === output.value
      ? { output, changed: false }
      : { output: { ...output, value: sanitized }, changed: true }
  }

  if (output.type !== 'content' || !isArray(output.value)) return { output, changed: false }

  let changed = false
  const nextValue = output.value.map((item) => {
    if (!isRecord(item) || item.type !== 'text') return item

    const sanitizedItem = sanitizeStringRecordField(item, 'text')
    if (!sanitizedItem) return item

    changed = true
    return sanitizedItem
  })

  return changed
    ? { output: { ...output, value: nextValue }, changed: true }
    : { output, changed: false }
}

function sanitizeContentPartSurrogates(part: unknown): {
  part: unknown
  changed: boolean
} {
  if (!isRecord(part)) return { part, changed: false }

  if (part.type === 'tool-call') {
    const sanitizedInput = sanitizeUnknownSurrogates(part.input)
    if (!sanitizedInput.changed) return { part, changed: false }

    return {
      part: {
        ...part,
        input: sanitizedInput.value,
      },
      changed: true,
    }
  }

  if (part.type === 'tool-result') {
    const sanitizedOutput = sanitizeToolResultOutputSurrogates(part.output)
    if (!sanitizedOutput.changed) return { part, changed: false }

    return {
      part: {
        ...part,
        output: sanitizedOutput.output,
      },
      changed: true,
    }
  }

  return sanitizeTextContentPartSurrogates(part)
}

function sanitizeInvalidSurrogatesFromMessage(
  message: ModelMessage
): ModelMessageSanitizationResult {
  if (isString(message.content)) {
    const sanitizedContent = sanitizeInvalidTextSurrogates(message.content)
    return sanitizedContent === message.content
      ? { message, changed: false }
      : { message: { ...message, content: sanitizedContent } as ModelMessage, changed: true }
  }

  if (!isArray(message.content)) return { message, changed: false }

  let changed = false
  const content = message.content.map((part) => {
    const result = sanitizeContentPartSurrogates(part)
    if (result.changed) {
      changed = true
    }
    return result.part
  })

  return changed
    ? { message: { ...message, content: content as ModelMessage['content'] } as ModelMessage, changed: true }
    : { message, changed: false }
}

function hasEffectiveAssistantPart(part: unknown): boolean {
  const text = readTextLikePart(part)
  if (isNonBlankString(text)) return true

  return isToolCallLikePart(part)
}

function isTextOnlyAssistantContent(content: unknown[]): boolean {
  return content.every((part) => isPresent(readTextLikePart(part)))
}

function extractTextOnlyAssistantContent(content: unknown[]): string {
  return content
    .map((part) => readTextLikePart(part))
    .filter((text): text is string => isString(text))
    .join('\n')
}

export function isReplayUnsafeAssistantMessage(message: ModelMessage): boolean {
  if (message.role !== 'assistant') return false

  const stopReason = toNullable((message as { stopReason?: unknown }).stopReason)
  if (stopReason === 'error' || stopReason === 'aborted') return true

  const content = message.content
  if (isString(content)) {
    const text = content.trim()
    return !text || isDisplayOnlyEmptyResponseText(text)
  }

  if (!isArray(content) || isEmpty(content)) return true

  if (
    isTextOnlyAssistantContent(content) &&
    isDisplayOnlyEmptyResponseText(extractTextOnlyAssistantContent(content))
  ) return true

  return !content.some((part) => hasEffectiveAssistantPart(part))
}

function isHistoricalBinaryPart(part: unknown): boolean {
  return isRecord(part) && (part.type === 'image' || part.type === 'file')
}

function buildHistoricalBinaryPlaceholder(part: unknown): { type: 'text'; text: string } {
  const type = isRecord(part) ? part.type : null
  return {
    type: 'text',
    text: type === 'file' ? HistoricalFilePlaceholder : HistoricalImagePlaceholder,
  }
}

function pruneHistoricalBinaryContent(content: unknown[]): {
  content: unknown[]
  changed: boolean
} {
  let changed = false
  const pruned: unknown[] = []
  let previousPlaceholderText: Nullable<string> = null

  content.forEach((part) => {
    if (!isHistoricalBinaryPart(part)) {
      pruned.push(part)
      previousPlaceholderText = null
      return
    }

    changed = true
    const placeholder = buildHistoricalBinaryPlaceholder(part)
    if (previousPlaceholderText !== placeholder.text) {
      pruned.push(placeholder)
      previousPlaceholderText = placeholder.text
    }
  })

  return { content: pruned, changed }
}

function pruneHistoricalBinaryPartsForProvider(
  history: ModelMessage[]
): ModelHistorySanitizationResult {
  let currentTurnStart = -1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') {
      currentTurnStart = index
      break
    }
  }

  if (currentTurnStart < 0) return { history, changedMessages: 0 }

  let lastAssistantBeforeTurn = -1
  for (let index = currentTurnStart - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'assistant') {
      lastAssistantBeforeTurn = index
      break
    }
  }

  if (lastAssistantBeforeTurn < 0) return { history, changedMessages: 0 }

  let nextHistory: Nullable<ModelMessage[]> = null
  let changedMessages = 0

  for (let index = 0; index < lastAssistantBeforeTurn; index += 1) {
    const message = history[index]
    if (message.role !== 'user' || !isArray(message.content)) {
      continue
    }

    const result = pruneHistoricalBinaryContent(message.content)
    if (!result.changed) {
      continue
    }

    nextHistory ??= history.slice()
    nextHistory[index] = {
      ...message,
      content: result.content as ModelMessage['content'],
    } as ModelMessage
    changedMessages += 1
  }

  return {
    history: nextHistory ?? history,
    changedMessages,
  }
}

function isToolResultBinaryContentPart(part: unknown): boolean {
  if (!isRecord(part)) return false

  return (
    part.type === 'image-data' ||
    part.type === 'media' ||
    part.type === 'file-data' ||
    part.type === 'file-url' ||
    part.type === 'file-id'
  )
}

function hasToolResultBinaryContent(output: unknown): boolean {
  return (
    isRecord(output) &&
    output.type === 'content' &&
    isArray(output.value) &&
    output.value.some((part) => isToolResultBinaryContentPart(part))
  )
}

function pruneToolResultBinaryContentForProvider(
  history: ModelMessage[]
): ModelHistorySanitizationResult {
  const references: Array<{ messageIndex: number; partIndex: number }> = []

  history.forEach((message, messageIndex) => {
    if (!isArray(message.content)) return

    const content: unknown[] = message.content
    content.forEach((part, partIndex) => {
      if (!isRecord(part) || part.type !== 'tool-result') return

      if (hasToolResultBinaryContent(part.output)) {
        references.push({ messageIndex, partIndex })
      }
    })
  })

  if (references.length <= MaxRecentToolResultContentImagesToKeep) return { history, changedMessages: 0 }

  const protectedKeys = new Set(
    references
      .slice(-MaxRecentToolResultContentImagesToKeep)
      .map((reference) => `${reference.messageIndex}:${reference.partIndex}`)
  )
  let changedMessages = 0
  const nextHistory = history.map((message, messageIndex) => {
    if (!isArray(message.content)) return message

    let changed = false
    const content: unknown[] = message.content
    const nextContent = content.map((part, partIndex) => {
      const key = `${messageIndex}:${partIndex}`
      if (protectedKeys.has(key) || !isRecord(part) || part.type !== 'tool-result') return part

      const output = part.output
      if (!hasToolResultBinaryContent(output) || !isRecord(output) || !isArray(output.value)) return part

      changed = true
      return {
        ...part,
        output: {
          ...output,
          value: output.value.map((contentPart) =>
            isToolResultBinaryContentPart(contentPart)
              ? { type: 'text', text: HistoricalToolImagePlaceholder }
              : contentPart
          ),
        },
      }
    })

    if (!changed) return message

    changedMessages += 1
    return {
      ...message,
      content: nextContent as ModelMessage['content'],
    } as ModelMessage
  })

  return { history: nextHistory, changedMessages }
}

function sanitizeToolCallPart(part: ToolCallPart): { part: ToolCallPart; changed: boolean } {
  const input = readToolInputRecord(part.input)
  const compactedInput = compactToolInputForModel(input)
  const changed = !hasSameProviderPayload(part.input, compactedInput)

  return {
    part: changed ? { ...part, input: compactedInput } : part,
    changed,
  }
}

function compactToolResultOutputValue(value: string): string {
  if (value.length <= ModelToolResultMaxSerializedLength) return value

  return serializeToolResultForModel(deserializeSerializedToolResult(value))
}

function hasFailureLikeTextPrefix(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('error:') || normalized.startsWith('blocked:')
}

function parseJsonFailureCandidate(value: string): Nullable<unknown> {
  const trimmed = value.trim()
  if (!trimmed.startsWith('"') && !trimmed.startsWith('{')) return null

  try {
    return JSON.parse(trimmed)
  } catch {
    // arch-guard:silent-catch-ok 非法 JSON 工具输出按普通文本处理。
    return null
  }
}

/**
 * 工具结果正文是否是「失败样」的。
 *
 * 失败结果不做正文压缩/折叠——错误原文是模型自纠的唯一线索，压掉它就等于让模型对着
 * 一句"[已折叠]"猜刚才为什么失败。原住 v1 `history/microCompaction.ts`，随该文件拆除迁来。
 */
function isFailureLikeToolResultValue(value: string): boolean {
  if (hasFailureLikeTextPrefix(value)) return true

  const parsed = parseJsonFailureCandidate(value)
  if (isString(parsed)) return hasFailureLikeTextPrefix(parsed)
  if (!isRecord(parsed)) return false

  if (isString(parsed.error) && !isBlank(parsed.error.trim())) return true
  if (!isString(parsed.status)) return false

  const status = parsed.status.trim().toLowerCase()
  return status === 'failed' || status === 'blocked' || status === 'error'
}

function sanitizeToolResultPart(part: ToolResultPart): {
  part: ToolResultPart
  changed: boolean
} {
  const output = part.output
  if (!isRecord(output)) return { part, changed: false }

  const outputRecord = output as Record<string, unknown>
  const outputType = outputRecord.type
  const outputValue = outputRecord.value
  if ((outputType !== 'text' && outputType !== 'error-text') || !isString(outputValue)) return { part, changed: false }
  if (outputType === 'error-text' || isFailureLikeToolResultValue(outputValue)) return { part, changed: false }

  const compactedValue = compactToolResultOutputValue(outputValue)
  if (compactedValue === outputValue) return { part, changed: false }

  return {
    part: {
      ...part,
      output: {
        ...outputRecord,
        value: compactedValue,
      },
    } as ToolResultPart,
    changed: true,
  }
}

function sanitizeModelContentArray(
  content: unknown[],
  options: ModelMessageSanitizationOptions = {}
): {
  content: unknown[]
  changed: boolean
} {
  let changed = false
  const sanitized = content.flatMap((part) => {
    if (
      isRecord(part) &&
      (part.type === 'tool-call' || part.type === 'tool-result') &&
      (!isNonBlankString(part.toolCallId) || !isNonBlankString(part.toolName))
    ) {
      changed = true
      return []
    }

    if (isToolCallPart(part)) {
      const result = sanitizeToolCallPart(part)
      changed = changed || result.changed
      return [result.part]
    }

    if (isToolResultPart(part)) {
      if (options.skipToolResultBudget) return [part]
      const result = sanitizeToolResultPart(part)
      changed = changed || result.changed
      return [result.part]
    }

    return [part]
  })

  const deduped = dedupeRepeatedModelContentParts(sanitized)
  changed = changed || deduped.changed

  return { content: deduped.content, changed }
}

function getToolPartKey(part: unknown): Nullable<string> {
  if (!isRecord(part)) return null

  if (part.type !== 'tool-call' && part.type !== 'tool-result') return null

  return isString(part.toolCallId) ? `${part.type}:${part.toolCallId}` : null
}

function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return isRecord(part) && part.type === 'text' && isString(part.text)
}

function dedupeRepeatedTextParts(content: unknown[]): {
  content: unknown[]
  changed: boolean
} {
  const textPartIndexes = content
    .map((part, index) => (isTextPart(part) ? index : -1))
    .filter((index) => index >= 0)
  if (textPartIndexes.length < 2) return { content, changed: false }

  const textParts = textPartIndexes.map((index) => content[index] as { type: 'text'; text: string })
  const collapsed = collapseRepeatedSequence(textParts, (left, right) => left.text === right.text)
  if (collapsed.length === textParts.length) return { content, changed: false }

  const keptTextIndexes = new Set(textPartIndexes.slice(0, collapsed.length))
  return {
    content: content.filter((part, index) => !isTextPart(part) || keptTextIndexes.has(index)),
    changed: true,
  }
}

function dedupeToolParts(content: unknown[]): {
  content: unknown[]
  changed: boolean
} {
  const deduped: unknown[] = []
  const seenIndexes = new Map<string, number>()
  let changed = false

  content.forEach((part) => {
    const toolPartKey = getToolPartKey(part)
    if (!toolPartKey) {
      deduped.push(part)
      return
    }

    const existingIndex = seenIndexes.get(toolPartKey)
    if (isNumber(existingIndex)) {
      deduped[existingIndex] = part
      changed = true
      return
    }

    seenIndexes.set(toolPartKey, deduped.length)
    deduped.push(part)
  })

  return { content: deduped, changed }
}

function dedupeRepeatedModelContentParts(content: unknown[]): {
  content: unknown[]
  changed: boolean
} {
  const textResult = dedupeRepeatedTextParts(content)
  const toolResult = dedupeToolParts(textResult.content)

  return {
    content: toolResult.content,
    changed: textResult.changed || toolResult.changed,
  }
}

export function sanitizeModelMessage(
  message: ModelMessage,
  options: ModelMessageSanitizationOptions = {}
): ModelMessageSanitizationResult {
  if (!isArray(message.content)) return { message, changed: false }

  const result = sanitizeModelContentArray(message.content, options)
  if (!result.changed) return { message, changed: false }

  return {
    message: {
      ...message,
      content: result.content as ModelMessage['content'],
    } as ModelMessage,
    changed: true,
  }
}

export function sanitizeModelHistory(
  history: ModelMessage[],
  options?: SanitizeModelHistoryOptions
): ModelHistorySanitizationResult {
  let changedMessages = 0
  const prunedHistory = pruneHistoricalBinaryPartsForProvider(history)
  changedMessages += prunedHistory.changedMessages
  const prunedToolBinaryHistory = pruneToolResultBinaryContentForProvider(prunedHistory.history)
  changedMessages += prunedToolBinaryHistory.changedMessages
  const sanitizedHistory = prunedToolBinaryHistory.history.map((message) => {
    const result = sanitizeModelMessage(message)
    const textResult = sanitizeInvalidSurrogatesFromMessage(result.message)
    if (result.changed || textResult.changed) {
      changedMessages += 1
    }
    return textResult.message
  })

  const repairedBlankToolCallIds = repairBlankToolCallIdsByAdjacentResults(sanitizedHistory)
  changedMessages += repairedBlankToolCallIds.changedMessages

  const backfilledToolCallNames = backfillAssistantToolCallNamesFromResults(
    repairedBlankToolCallIds.history
  )
  changedMessages += backfilledToolCallNames.changedMessages

  let workingHistory = backfilledToolCallNames.history
  if (options?.stripProviderSpecificMetadata) {
    const strippedProviderMetadata = stripProviderSpecificMetadataFromHistory(workingHistory)
    workingHistory = strippedProviderMetadata.history
    changedMessages += strippedProviderMetadata.changedMessages
  }

  return {
    history: changedMessages > 0 ? workingHistory : history,
    changedMessages,
  }
}
export { sanitizeModelHistory as sanitizeModelHistoryForProvider }
export { sanitizeModelMessage as sanitizeModelMessageForProvider }
export type { UserTextPayloadReference }
