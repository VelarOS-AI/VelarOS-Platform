import {
  type ConversationTranslator,
  conversationTranslatorRuntime,
} from '../i18n/conversationTranslator'
import type { ConversationMessageRunMarker } from '../projection'
import type { ChatInlineNoticeMeta } from '../status/chatStatus'
import { isGoalToolStateToolName } from '../tool-render/goal/goalToolBlock'
import {
  isToolActivitySummaryExcludedToolCall,
  type ToolActivitySummaryExclusionPredicate,
  type ToolRenderSegment,
} from '../tool-render/toolCallRenderGrouping'
import { formatToolDurationMs } from '../tool-render/toolCallSummary'

import { formatMessageCostEstimate } from './messageCostEstimate'
import { formatExactNumber } from './numberFormat'

import type {
  AppLocale,
  ChatAttachmentMeta,
  ChatMessage,
  ContentBlock,
  SerializedImageAttachment,
  TextBlock,
  ToolCallBlock as ToolCallBlockType,
} from '#contracts'
import { isBlank, isEmpty, isFalse, isFiniteNumber, isPresent, optionalWhenLazy } from '#internal/runtime'

/**
 * `ConversationMessageRunMarker` 现住投影层（`../projection`）——气泡渲染模型 + memo 比较器 + transcript
 * 派生共用；此处再导出，既有 blocks 消费者继续从本模块引入不受影响。
 */
export type { ConversationMessageRunMarker } from '../projection'

export type MessageRenderSegment =
  | {
      kind: 'activity-group'
      key: string
      segments: ToolRenderSegment[]
      blocks: ToolCallBlockType[]
    }
  | { kind: 'segment'; key: string; segment: ToolRenderSegment }

export interface MessageRenderSegmentOptions {
  isToolActivitySummaryExcludedToolCall?: ToolActivitySummaryExclusionPredicate
}

export interface VisibleMessageBlockOptions {
  hidePlanToolBlocks?: boolean
  /** 置顶执行中的计划只隐藏对应快照；历史已落盘计划必须继续留在 transcript。 */
  hiddenPlanToolCallId?: LooseOptional<string>
  hideGoalToolBlocks?: boolean
  /** 纯展示过滤：false 时保留消息数据，只从当前渲染树移除 thinking block。 */
  showThinkingProcess?: boolean
  /** 当前仍在等待作答的阻塞式动作卡 id；用于判断卡片是「待答」还是「已答」，据此决定是否隐藏同消息内的叙述文本。 */
  activeUserActionCardIds?: readonly string[]
}

export interface GoalCompletionActivitySummary {
  durationMs: Nullable<number>
  totalTokens: Nullable<number>
  costUsd: Nullable<number>
}

export interface ProcessedActivityDisclosureLabelOptions {
  goalCompletionSummary?: LooseOptional<GoalCompletionActivitySummary>
  responseDurationMs?: LooseOptional<number>
  isRunning?: boolean
}

export interface ProcessedActivitySummaryBoundaryOptions {
  allowTrailingActivity?: boolean
}

export interface ProcessedActivitySummaryBoundarySignalOptions {
  isStreaming: boolean
  runMarker?: LooseOptional<Pick<ConversationMessageRunMarker, 'status' | 'turnKind'>>
}

export interface ProcessedActivitySummaryPartition {
  processedSegments: MessageRenderSegment[]
  outsideSegments: MessageRenderSegment[]
  trailingSegments: MessageRenderSegment[]
}

export interface AssistantGeneratedArtifactsVisibilityOptions {
  isStreaming: boolean
  runMarker?: LooseOptional<Pick<ConversationMessageRunMarker, 'status'>>
}

export function shouldShowAssistantGeneratedArtifacts({
  isStreaming,
  runMarker,
}: AssistantGeneratedArtifactsVisibilityOptions): boolean {
  if (isStreaming) return false
  if (!runMarker) return true

  return runMarker.status === 'completed'
}

function isResponseDurationTimestamp(value: LooseOptional<number>): value is number {
  return isFiniteNumber(value) && value >= 0
}

export function shouldUseProcessedActivitySummaryBoundary({
  isStreaming,
  runMarker,
}: ProcessedActivitySummaryBoundarySignalOptions): boolean {
  if (isStreaming) return false
  if (runMarker?.status === 'awaiting-confirmation' || runMarker?.status === 'awaiting-input')
    return false

  return runMarker?.status === 'completed'
}

export function getAssistantResponseDurationMs(options: {
  questionMessage?: LooseOptional<Pick<ChatMessage, 'timestamp'>>
  runMarker?: LooseOptional<Pick<ConversationMessageRunMarker, 'status' | 'timestamp'>>
  isStreaming?: boolean
}): Nullable<number> {
  if (options.isStreaming) return null

  const startedAt = options.questionMessage?.timestamp
  if (!isResponseDurationTimestamp(startedAt)) return null

  const runMarker = options.runMarker
  if (!runMarker) return null

  if (runMarker.status === 'awaiting-input' || runMarker.status === 'awaiting-confirmation')
    return null

  const finishedAt = runMarker.timestamp
  if (!isResponseDurationTimestamp(finishedAt)) return null

  return Math.max(0, finishedAt - startedAt)
}

function getTextBlockTone(block: TextBlock): NonNullable<TextBlock['tone']> {
  return block.tone ?? 'default'
}

function coalesceTextBlocksAcrossThinking(blocks: ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (!block) continue

    if (block.type !== 'text') {
      result.push(block)
      continue
    }

    let textBlock: TextBlock = block
    const deferredThinkingBlocks: ContentBlock[] = []
    let cursor = index + 1

    for (; cursor < blocks.length; cursor += 1) {
      const nextBlock = blocks[cursor]
      if (!nextBlock) continue

      if (nextBlock.type === 'thinking') {
        deferredThinkingBlocks.push(nextBlock)
        continue
      }

      if (
        nextBlock.type === 'text' &&
        getTextBlockTone(nextBlock) === getTextBlockTone(textBlock)
      ) {
        textBlock = {
          ...textBlock,
          text: textBlock.text + nextBlock.text,
        }
        continue
      }

      break
    }

    result.push(textBlock, ...deferredThinkingBlocks)
    index = cursor - 1
  }

  return result
}

export function extractMessageText(message: ChatMessage): string {
  let result = ''

  for (const block of message.blocks) {
    if (block.type !== 'text') continue

    const text = block.text.trimEnd()
    if (isBlank(text)) continue

    result = result ? `${result}\n\n${text}` : text
  }

  return result.trim()
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatMessageTime(timestamp: number, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

export function formatMessageDateTime(timestamp: number, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}

export function buildImageAttachmentSrc(attachment: SerializedImageAttachment): string {
  return `data:${attachment.mediaType || 'image/png'};base64,${attachment.data}`
}

export function getVisibleMessageBlocks(
  message: ChatMessage,
  showToolDetails: boolean,
  options: VisibleMessageBlockOptions = {}
): ContentBlock[] {
  // 阻塞式动作卡（含 ask_user 提问卡）「等待作答期间」，把同一条消息里的 text 叙述隐藏、让卡片成为焦点。
  // 一旦卡片被作答/解除（不再出现在 activeUserActionCardIds 里），模型在同一条消息追加的最终答复必须照常渲染，
  // 否则 ask_user 作答后的结论会被吞掉。仅凭 block.card.blocking 无法区分「待答/已答」——它始终为 true。
  const activeUserActionCardIds = options.activeUserActionCardIds
  const hasPendingBlockingUserActionCard =
    !!activeUserActionCardIds &&
    message.blocks.some(
      (block) =>
        block.type === 'user-action-card' &&
        block.card.blocking &&
        activeUserActionCardIds.includes(block.card.id)
    )

  const visibleBlocks: ContentBlock[] = []
  message.blocks.forEach((block) => {
    if (block.type === 'project-auto-approval') return
    if (isFalse(options.showThinkingProcess) && block.type === 'thinking') return
    if (hasPendingBlockingUserActionCard && block.type === 'text') return
    if (block.type !== 'tool-call') {
      visibleBlocks.push(block)
      return
    }

    if (
      block.toolName === 'plan:update' &&
      (options.hidePlanToolBlocks || block.toolCallId === options.hiddenPlanToolCallId)
    )
      return
    if (options.hideGoalToolBlocks && isGoalToolStateToolName(block.toolName)) return

    if (showToolDetails) visibleBlocks.push(block)
  })

  return coalesceTextBlocksAcrossThinking(visibleBlocks)
}

export function hasVisibleSegmentContent(segment: ToolRenderSegment): boolean {
  switch (segment.kind) {
    case 'tool-group':
      return !isEmpty(segment.blocks)
    case 'merged-tool':
      return !isEmpty(segment.group.blocks)
    case 'block':
      break
  }

  switch (segment.block.type) {
    case 'tool-call':
    case 'system-tool-install-suggestion':
    case 'capability-auto-approval':
    case 'html-artifact':
    case 'user-action-card':
    case 'scheduled-task-proposal':
      return true
    case 'project-auto-approval':
      return false
    case 'text':
      return !isBlank(segment.block.text)
    default:
      return false
  }
}

export function shouldRenderSegmentOutsideProcessedActivityDisclosure(
  segment: MessageRenderSegment
): boolean {
  if (segment.kind !== 'segment') return false
  if (segment.segment.kind !== 'block') return false

  const { block } = segment.segment
  // 未创建的提案卡要留在「已处理」折叠外（用户还得填它）；已结算的收进折叠里。
  if (block.type === 'scheduled-task-proposal') return !block.resolution

  // HTML artifact 是用户要看的成品预览,始终展开在「已处理」折叠外,不能被工具活动收起。
  if (block.type === 'html-artifact') return true

  return block.type === 'tool-call' && isToolActivitySummaryExcludedToolCall(block)
}

/**
 * 最终答复前的工具活动只能形成一个「已处理」分组。需要外置的成品卡从分组中提取，
 * 统一排在该分组下方；这样插入计划卡、Widget 或交互卡时不会把「已处理」切成两段。
 */
export function partitionProcessedActivitySummarySegments(
  segments: MessageRenderSegment[],
  summaryBoundaryIndex: number
): ProcessedActivitySummaryPartition {
  const processedSegments: MessageRenderSegment[] = []
  const outsideSegments: MessageRenderSegment[] = []
  const trailingSegments: MessageRenderSegment[] = []
  const boundary = Math.max(0, Math.min(summaryBoundaryIndex, segments.length))

  for (let index = 0; index < boundary; index += 1) {
    const segment = segments[index]
    if (!segment) continue

    if (shouldRenderSegmentOutsideProcessedActivityDisclosure(segment)) {
      outsideSegments.push(segment)
      continue
    }

    processedSegments.push(segment)
  }

  for (let index = boundary; index < segments.length; index += 1) {
    const segment = segments[index]
    if (!segment) continue

    // 续答或块合并有时会把已经结束的思考过程延后到最终正文之后。
    // 完成态下将这类孤立思考重新归入唯一的「已处理」分组，正文和成品卡仍留在外面。
    if (summaryBoundaryIndex >= 0 && messageSegmentIsThinking(segment)) {
      processedSegments.push(segment)
      continue
    }

    trailingSegments.push(segment)
  }

  return {
    processedSegments,
    outsideSegments,
    trailingSegments,
  }
}

function findLastVisibleToolRenderSegment(
  segments: ToolRenderSegment[]
): ToolRenderSegment | undefined {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (segment && hasVisibleSegmentContent(segment)) return segment
  }

  return undefined
}

export function getStreamingTextSegmentKey(segments: ToolRenderSegment[]): string | undefined {
  const tailSegment = findLastVisibleToolRenderSegment(segments)

  return optionalWhenLazy(
    tailSegment?.kind === 'block' && tailSegment.block.type === 'text',
    () => tailSegment!.key
  )
}

export function getLastTextSegmentKey(segments: readonly ToolRenderSegment[]): string | undefined {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (segment?.kind === 'block' && segment.block.type === 'text' && !isBlank(segment.block.text))
      return segment.key
  }

  return undefined
}

function getToolBlocksFromRenderSegment(
  segment: ToolRenderSegment,
  isExcludedToolCall: ToolActivitySummaryExclusionPredicate = isToolActivitySummaryExcludedToolCall
): ToolCallBlockType[] {
  const collectVisibleToolBlocks = (blocks: readonly ToolCallBlockType[]): ToolCallBlockType[] => {
    const visibleBlocks: ToolCallBlockType[] = []

    for (const block of blocks) {
      if (!isExcludedToolCall(block)) visibleBlocks.push(block)
    }

    return visibleBlocks
  }

  switch (segment.kind) {
    case 'tool-group':
      return collectVisibleToolBlocks(segment.blocks)
    case 'merged-tool':
      return collectVisibleToolBlocks(segment.group.blocks)
    case 'block':
      return segment.block.type === 'tool-call' && !isExcludedToolCall(segment.block)
        ? [segment.block]
        : []
  }
}

export function buildMessageRenderSegments(
  segments: ToolRenderSegment[],
  options: MessageRenderSegmentOptions = {}
): MessageRenderSegment[] {
  const messageSegments: MessageRenderSegment[] = []
  let pendingSegments: ToolRenderSegment[] = []
  let pendingBlocks: ToolCallBlockType[] = []
  const isExcludedToolCall =
    options.isToolActivitySummaryExcludedToolCall ?? isToolActivitySummaryExcludedToolCall

  const flushPendingSegments = (): void => {
    if (isEmpty(pendingSegments)) return

    messageSegments.push({
      kind: 'activity-group',
      key: `activity:${pendingBlocks[0]?.toolCallId ?? pendingSegments[0].key}`,
      segments: pendingSegments,
      blocks: pendingBlocks,
    })
    pendingSegments = []
    pendingBlocks = []
  }

  segments.forEach((segment) => {
    const toolBlocks = getToolBlocksFromRenderSegment(segment, isExcludedToolCall)

    if (!isEmpty(toolBlocks)) {
      pendingSegments.push(segment)
      pendingBlocks.push(...toolBlocks)
      return
    }

    flushPendingSegments()
    messageSegments.push({
      kind: 'segment',
      key: segment.key,
      segment,
    })
  })

  flushPendingSegments()
  return messageSegments
}

function messageSegmentHasStartedText(segment: MessageRenderSegment): boolean {
  return (
    segment.kind === 'segment' &&
    segment.segment.kind === 'block' &&
    segment.segment.block.type === 'text' &&
    !isBlank(segment.segment.block.text)
  )
}

function messageSegmentIsThinking(segment: MessageRenderSegment): boolean {
  return (
    segment.kind === 'segment' &&
    segment.segment.kind === 'block' &&
    segment.segment.block.type === 'thinking' &&
    !isBlank(segment.segment.block.text)
  )
}

function messageRenderSegmentHasVisibleContent(segment: MessageRenderSegment): boolean {
  if (segment.kind === 'activity-group') return segment.segments.some(hasVisibleSegmentContent)

  return hasVisibleSegmentContent(segment.segment)
}

function messageRenderSegmentIsTrailingActivity(segment: MessageRenderSegment): boolean {
  return (
    (segment.kind === 'activity-group' && !isEmpty(segment.blocks)) ||
    messageSegmentIsThinking(segment)
  )
}

export function getProcessedActivitySummaryBoundaryIndex(
  segments: MessageRenderSegment[],
  options: ProcessedActivitySummaryBoundaryOptions = {}
): number {
  let summaryTextIndex = -1

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (!segment || !messageRenderSegmentHasVisibleContent(segment)) {
      continue
    }

    if (messageSegmentHasStartedText(segment)) {
      summaryTextIndex = index
      break
    }

    // 完成态正文后出现思考块属于异常尾巴；始终允许越过它寻找最终正文边界，
    // 后续 partition 会把它兜底搬回「已处理」。普通尾部工具活动仍沿用显式开关。
    if (
      messageSegmentIsThinking(segment) ||
      (options.allowTrailingActivity && messageRenderSegmentIsTrailingActivity(segment))
    ) {
      continue
    }

    return -1
  }

  if (summaryTextIndex < 0) return -1

  return summaryTextIndex
}


function formatGoalCompletionActivityLabel(
  summary: GoalCompletionActivitySummary,
  locale: AppLocale,
  translatorRuntime: ConversationTranslator
): string {
  const conversationTranslate = translatorRuntime.translate
  const details: string[] = []

  if (isFiniteNumber(summary.durationMs)) {
    details.push(
      conversationTranslate(locale, 'chat.goalCompletedDuration', {
        duration: formatToolDurationMs(summary.durationMs, locale, translatorRuntime),
      })
    )
  }

  if (isFiniteNumber(summary.totalTokens)) {
    details.push(
      conversationTranslate(locale, 'chat.goalCompletedTokens', {
        tokens: formatExactNumber(locale, Math.max(0, Math.round(summary.totalTokens))),
      })
    )
  }

  if (isFiniteNumber(summary.costUsd)) {
    details.push(
      conversationTranslate(locale, 'chat.goalCompletedCost', {
        cost: formatMessageCostEstimate(locale, Math.max(0, summary.costUsd)),
      })
    )
  }

  if (isEmpty(details)) return conversationTranslate(locale, 'chat.goalCompleted')

  return conversationTranslate(locale, 'chat.goalCompletedWithDetails', {
    details: details.join(' · '),
  })
}

export function getProcessedActivityDisclosureLabel(
  blocks: Array<Pick<ToolCallBlockType, 'isRunning'>>,
  locale: AppLocale,
  options: ProcessedActivityDisclosureLabelOptions = {},
  translatorRuntime: ConversationTranslator = conversationTranslatorRuntime
): string {
  const conversationTranslate = translatorRuntime.translate
  if (options.goalCompletionSummary)
    return formatGoalCompletionActivityLabel(
      options.goalCompletionSummary,
      locale,
      translatorRuntime
    )

  const isRunning = options.isRunning || blocks.some((block) => block.isRunning)
  if (isRunning) return conversationTranslate(locale, 'chat.processedActivity')

  const responseDurationMs = options.responseDurationMs
  if (isPresent(responseDurationMs) && Math.max(0, Math.round(responseDurationMs)) > 0)
    return conversationTranslate(locale, 'chat.processedActivityWithDuration', {
      duration: formatToolDurationMs(responseDurationMs, locale, translatorRuntime),
    })

  return conversationTranslate(locale, 'chat.processedActivity')
}

export function areRunMarkersEqual(
  prev: LooseOptional<ConversationMessageRunMarker>,
  next: LooseOptional<ConversationMessageRunMarker>
): boolean {
  if (prev === next) return true

  if (!prev || !next) return prev === next

  return (
    prev.messageId === next.messageId &&
    prev.status === next.status &&
    prev.detail === next.detail &&
    prev.turnCount === next.turnCount &&
    prev.turnKind === next.turnKind &&
    prev.goalMode === next.goalMode &&
    prev.workspaceCheckpointDiff?.capturedAt === next.workspaceCheckpointDiff?.capturedAt &&
    prev.workspaceCheckpointDiff?.error === next.workspaceCheckpointDiff?.error &&
    prev.workspaceCheckpointDiff?.changes === next.workspaceCheckpointDiff?.changes &&
    prev.workspaceCheckpointDiff?.failedRoots === next.workspaceCheckpointDiff?.failedRoots &&
    prev.timestamp === next.timestamp
  )
}

export function areInlineNoticesEqual(
  prev: LooseOptional<ChatInlineNoticeMeta>,
  next: LooseOptional<ChatInlineNoticeMeta>
): boolean {
  if (prev === next) return true

  if (!prev || !next) return prev === next

  return prev.text === next.text && prev.tone === next.tone
}

export function buildPreviewItems(
  attachments: ChatAttachmentMeta[],
  imageAttachments: SerializedImageAttachment[]
): Array<{ id: string; src: string; alt: string; title: string; description: string }> {
  const imageAttachmentMap = new Map<string, SerializedImageAttachment>()
  for (const attachment of imageAttachments) {
    imageAttachmentMap.set(attachment.id, attachment)
  }
  const previewItems: Array<{
    id: string
    src: string
    alt: string
    title: string
    description: string
  }> = []

  for (const attachment of attachments) {
    if (attachment.kind !== 'image') continue

    const imageAttachment = imageAttachmentMap.get(attachment.id)
    if (!imageAttachment) continue

    previewItems.push({
      id: attachment.id,
      src: buildImageAttachmentSrc(imageAttachment),
      alt: attachment.name,
      title: attachment.name,
      description: formatAttachmentSize(attachment.size),
    })
  }

  return previewItems
}
