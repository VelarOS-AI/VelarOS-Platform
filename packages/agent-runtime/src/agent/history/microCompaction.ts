import type { ModelMessage } from 'ai'

import { isArray, isBlank, isPresent,isRecord, isString } from '@velaros-ai/core'

import { buildContextRefEnvelope, isFoldStubText } from '../context/contextRefEnvelope'

import { isInternalFollowUpMessage } from './internalMessages'

/** 单个 conversation 内保留完整正文的最近工具结果条数。 */
export const MinRecentToolResultsPerConversation = 6

/**
 * 蒸馏折叠工具名：模型调用它声明「之前的工具结果已消化」。
 * 该结果在 conversation 内构成消化边界——边界前的非失败工具结果立即折叠成
 * recall 句柄（不再等 keep 窗口被动触发）；蒸馏便签本身永久保留充当断点锚。
 */
export const ContextDistillToolName = 'distill_context'

/** 单条 user 正文超过该长度时触发安全阀截断。 */
export const MaxUserMessageInlineChars = 48_000

/** {@link enforceOversizedUserTextSafetyValve} 与 user-text payload 持久化共用阈值。 */
export const OversizedUserTextSafetyValveChars = MaxUserMessageInlineChars

export interface UserTextPayloadReference {
  messageIndex: number
  payloadRef: string
  hash: string
  originalChars: number
}

/** micro-compact 替换正文时保留的 excerpt 长度。 */
const MicroCompactExcerptChars = 400

interface ToolResultSlot {
  messageIndex: number
  partIndex: number
  toolCallId: string
  toolName: string
  value: string
}

interface ConversationSlice {
  startIndex: number
  endIndex: number
}

function isConversationStartMessage(message: ModelMessage): boolean {
  return message.role === 'user' && !isInternalFollowUpMessage(message)
}

function splitConversationSlices(history: ModelMessage[]): ConversationSlice[] {
  const slices: ConversationSlice[] = []
  let startIndex = 0

  for (let index = 1; index <= history.length; index += 1) {
    const message = history[index]
    if (index === history.length || (message && isConversationStartMessage(message))) {
      slices.push({ startIndex, endIndex: index })
      startIndex = index
    }
  }

  return slices
}

function readTextToolResultValue(part: unknown): Nullable<string> {
  if (!isRecord(part) || part.type !== 'tool-result' || !isRecord(part.output)) return null

  const outputType = part.output.type
  const outputValue = part.output.value
  if (outputType !== 'text' || !isString(outputValue)) return null

  return outputValue
}

export function isFailureLikeToolResultValue(value: string): boolean {
  if (hasFailureLikeTextPrefix(value)) return true

  const parsed = parseJsonFailureCandidate(value)
  if (isString(parsed)) return hasFailureLikeTextPrefix(parsed)
  if (!isRecord(parsed)) return false

  if (isString(parsed.error) && !isBlank(parsed.error.trim())) return true
  if (!isString(parsed.status)) return false

  const status = parsed.status.trim().toLowerCase()
  return status === 'failed' || status === 'blocked' || status === 'error'
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

function isAlreadyMicroCompacted(value: string): boolean {
  // 统一嗅探(B1):任意代际折叠桩都不再二次折叠——旧实现只认自家 kind,
  // __kernelRef/__truncated 桩会被再压成"桩中桩"。
  return isFoldStubText(value)
}

function buildMicroCompactToolResultReference(slot: ToolResultSlot): string {
  const excerpt = slot.value.slice(0, MicroCompactExcerptChars).trimEnd()
  // B2:统一信封(共享 builder;判别键值不变,补 v/顶层 ref)。
  return JSON.stringify(
    buildContextRefEnvelope({
      __contextRef: 'micro-compacted-tool-result',
      ref: slot.toolCallId,
      toolCallId: slot.toolCallId,
      toolName: slot.toolName,
      excerpt,
      excerptKind: 'head',
      excerptTruncated: slot.value.length > excerpt.length,
      originalLength: slot.value.length,
      retrieval: {
        tool: 'recall_context',
        args: {
          ref: slot.toolCallId,
          refKind: 'tool-payload',
          reason: 'need full historical tool result',
          maxChars: 8_000,
        },
      },
    })
  )
}

function collectToolResultSlots(history: ModelMessage[], slice: ConversationSlice): ToolResultSlot[] {
  const slots: ToolResultSlot[] = []

  for (let messageIndex = slice.startIndex; messageIndex < slice.endIndex; messageIndex += 1) {
    const message = history[messageIndex]
    if (!isArray(message.content)) continue

    const content: unknown[] = message.content
    content.forEach((part, partIndex) => {
      const value = readTextToolResultValue(part)
      if (!isPresent(value) || !isRecord(part)) return

      const toolCallId = part.toolCallId
      const toolName = part.toolName
      if (!isString(toolCallId) || !isString(toolName)) return

      slots.push({
        messageIndex,
        partIndex,
        toolCallId,
        toolName,
        value,
      })
    })
  }

  return slots
}

export interface ConversationScopedToolCompactionResult {
  history: ModelMessage[]
  changedMessages: number
  compactedCount: number
}

/**
 * conversation 级 micro-compact：每个 user conversation 内只保留最近 K 条工具结果全文，
 * 更早结果替换为 excerpt + recall_context 句柄。
 *
 * 消化边界：conversation 内最后一次 distill_context 之前的非失败工具结果不受 keep 窗口
 * 保护，立即折叠；keep 窗口只作用于边界之后的结果。蒸馏便签自身永不折叠。
 */
export function enforceConversationScopedToolResultBudget(
  history: ModelMessage[],
  recentToolResultsToKeep: number = MinRecentToolResultsPerConversation
): ConversationScopedToolCompactionResult {
  const keepCount = Math.max(0, Math.floor(recentToolResultsToKeep))
  const replacements = new Map<string, string>()

  for (const slice of splitConversationSlices(history)) {
    const slots = collectToolResultSlots(history, slice)
    const lastDistillOrdinal = slots.findLastIndex(
      (slot) => slot.toolName === ContextDistillToolName
    )
    const postBoundarySlots = lastDistillOrdinal >= 0
      ? slots.slice(lastDistillOrdinal + 1)
      : slots
    if (lastDistillOrdinal < 0 && slots.length <= keepCount) continue

    const protectedIndexes = new Set(
      postBoundarySlots.slice(-keepCount).map((slot) => `${slot.messageIndex}:${slot.partIndex}`)
    )

    for (const slot of slots) {
      const key = `${slot.messageIndex}:${slot.partIndex}`
      if (
        slot.toolName === ContextDistillToolName ||
        protectedIndexes.has(key) ||
        isAlreadyMicroCompacted(slot.value) ||
        isFailureLikeToolResultValue(slot.value)
      ) continue

      replacements.set(key, buildMicroCompactToolResultReference(slot))
    }
  }

  if (!replacements.size) return { history, changedMessages: 0, compactedCount: 0 }

  let changedMessages = 0
  const nextHistory = history.map((message, messageIndex) => {
    if (!isArray(message.content)) return message

    let changed = false
    const content: unknown[] = message.content
    const nextContent = content.map((part, partIndex) => {
      const replacement = replacements.get(`${messageIndex}:${partIndex}`)
      if (!replacement || !isRecord(part) || !isRecord(part.output)) return part

      changed = true
      return {
        ...part,
        output: {
          ...part.output,
          value: replacement,
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

  return {
    history: nextHistory,
    changedMessages,
    compactedCount: replacements.size,
  }
}

export interface OversizedUserTextCompactionResult {
  history: ModelMessage[]
  changedMessages: number
  truncatedCount: number
}

function buildTruncatedUserTextReference(
  originalLength: number,
  excerpt: string,
  payloadRef?: string
): string {
  const storageHint = payloadRef
    ? `[user text stored at ${payloadRef}; originalLength=${originalLength}; use conversation.retrieveContextPayload to recover full text.]`
    : `[user text truncated before provider replay; originalLength=${originalLength}; use recall_context(ref, refKind:"context-handle") if the full text was stored.]`

  return [excerpt, '', storageHint].join('\n')
}

function truncateUserMessageContent(
  content: string,
  maxChars: number,
  payloadRef?: string
): Nullable<string> {
  if (content.length <= maxChars) return null

  const excerpt = content.slice(0, Math.max(0, maxChars - 200)).trimEnd()
  return buildTruncatedUserTextReference(content.length, excerpt, payloadRef)
}

/**
 * 超大 user 正文安全阀：截断并保留 excerpt，避免单条 user 消息撑爆 provider payload。
 */
export function enforceOversizedUserTextSafetyValve(
  history: ModelMessage[],
  maxInlineChars: number = MaxUserMessageInlineChars,
  payloadRefsByMessageIndex?: ReadonlyMap<number, UserTextPayloadReference>
): OversizedUserTextCompactionResult {
  const limit = Math.max(1_000, Math.floor(maxInlineChars))
  let changedMessages = 0
  let truncatedCount = 0

  const nextHistory = history.map((message, messageIndex) => {
    if (message.role !== 'user') return message

    const payloadRef = payloadRefsByMessageIndex?.get(messageIndex)?.payloadRef

    if (isString(message.content)) {
      const replacement = truncateUserMessageContent(message.content, limit, payloadRef)
      if (!replacement) return message

      changedMessages += 1
      truncatedCount += 1
      return {
        ...message,
        content: replacement,
      } as ModelMessage
    }

    if (!isArray(message.content)) return message

    let changed = false
    const nextContent = message.content.map((part) => {
      if (!isRecord(part) || part.type !== 'text' || !isString(part.text)) return part

      const replacement = truncateUserMessageContent(part.text, limit, payloadRef)
      if (!replacement) return part

      changed = true
      truncatedCount += 1
      return {
        ...part,
        text: replacement,
      }
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
    truncatedCount,
  }
}
