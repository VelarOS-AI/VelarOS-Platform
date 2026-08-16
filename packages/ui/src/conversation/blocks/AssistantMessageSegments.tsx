import React, {
  memo,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from 'react'

import { useConversationI18n, useConversationTranslatorRuntime } from '../i18n'
import type { ToolRenderSegment } from '../tool-render/toolCallRenderGrouping'

import {
  type ConversationMessageRunMarker,
  getAssistantResponseDurationMs,
  getProcessedActivityDisclosureLabel,
  getProcessedActivitySummaryBoundaryIndex,
  type GoalCompletionActivitySummary,
  type MessageRenderSegment,
  partitionProcessedActivitySummarySegments,
  shouldUseProcessedActivitySummaryBoundary,
} from './messageBubbleRenderModel'
import { MessageContentBlock } from './MessageContentBlock'
import {
  MergedToolCallRow,
  preloadToolActivityRenderer,
  ToolActivityDisclosure,
  ToolCallGroup,
} from './MessageToolActivity'

import styles from './MessageBubble.module.css'

import type {
  ChatMessage,
  ContentBlock,
  ToolCallBlock as ToolCallBlockType,
  UserActionCardResult,
} from '#contracts'
import { isBlank, isEmpty, isPresent, optionalWhenLazy } from '#internal/runtime'

interface MessageSegmentSuffixState {
  hasStartedTextAfter: boolean
  hasStartedThinkingAfter: boolean
  hasStartedToolActivityAfter: boolean
}

type ActivitySegmentRenderer = () => Nullable<ReactElement>

const EmptyMessageSegmentSuffixState: MessageSegmentSuffixState = {
  hasStartedTextAfter: false,
  hasStartedThinkingAfter: false,
  hasStartedToolActivityAfter: false,
}

function messageSegmentStartsText(segment: MessageRenderSegment): boolean {
  return (
    segment.kind === 'segment' &&
    segment.segment.kind === 'block' &&
    segment.segment.block.type === 'text' &&
    !isBlank(segment.segment.block.text)
  )
}

function messageSegmentStartsThinking(segment: MessageRenderSegment): boolean {
  return (
    segment.kind === 'segment' &&
    segment.segment.kind === 'block' &&
    segment.segment.block.type === 'thinking' &&
    !isBlank(segment.segment.block.text)
  )
}

function messageSegmentStartsToolActivity(segment: MessageRenderSegment): boolean {
  return segment.kind === 'activity-group' && !isEmpty(segment.blocks)
}

function buildMessageSegmentSuffixStates(
  segments: readonly MessageRenderSegment[]
): MessageSegmentSuffixState[] {
  const suffixStates: MessageSegmentSuffixState[] = []
  let hasStartedTextAfter = false
  let hasStartedThinkingAfter = false
  let hasStartedToolActivityAfter = false

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    suffixStates[index] = {
      hasStartedTextAfter,
      hasStartedThinkingAfter,
      hasStartedToolActivityAfter,
    }

    if (!segment) continue

    hasStartedTextAfter ||= messageSegmentStartsText(segment)
    hasStartedThinkingAfter ||= messageSegmentStartsThinking(segment)
    hasStartedToolActivityAfter ||= messageSegmentStartsToolActivity(segment)
  }

  return suffixStates
}

function shouldRenderActivityGroupDisclosure(segment: MessageRenderSegment): boolean {
  return segment.kind === 'activity-group' && !isEmpty(segment.blocks)
}

function collectToolCallBlocksFromToolRenderSegment(
  segment: ToolRenderSegment,
  blocks: ToolCallBlockType[]
): void {
  switch (segment.kind) {
    case 'tool-group':
      blocks.push(...segment.blocks)
      return
    case 'merged-tool':
      blocks.push(...segment.group.blocks)
      return
    case 'block':
      if (segment.block.type === 'tool-call') {
        blocks.push(segment.block)
      }
      return
  }
}

function collectToolCallBlocksFromMessageRenderSegment(
  segment: MessageRenderSegment,
  blocks: ToolCallBlockType[]
): void {
  if (segment.kind === 'activity-group') {
    blocks.push(...segment.blocks)
    return
  }

  collectToolCallBlocksFromToolRenderSegment(segment.segment, blocks)
}

function AssistantMessageSegmentsInner({
  messageRenderSegments,
  isStreaming,
  messageId,
  lastTextSegmentKey,
  streamingTextSegmentKey,
  sessionId,
  runMarker = null,
  planUpdateIndexByToolCallId,
  getBlockIndex,
  formatPathForDisplay,
  onOpenBrowserLink,
  onOpenProjectPath,
  activeUserActionCardIds,
  onResolveUserActionCard,
  onTranslateThinkingBlock,
  activityLeadingElement = null,
  activityTrailingElement = null,
  goalCompletionSummary = null,
  questionMessage = null,
  renderAfterToolCall,
}: {
  messageRenderSegments: MessageRenderSegment[]
  isStreaming: boolean
  messageId: string
  lastTextSegmentKey?: string
  streamingTextSegmentKey?: LooseOptional<string>
  sessionId: string
  runMarker?: LooseOptional<ConversationMessageRunMarker>
  questionMessage?: LooseOptional<ChatMessage>
  planUpdateIndexByToolCallId?: ReadonlyMap<string, number>
  getBlockIndex?: (block: ContentBlock) => number | undefined
  formatPathForDisplay?: (path: string) => string
  onOpenBrowserLink?: (url: string) => void | Promise<void>
  onOpenProjectPath?: (path: string) => unknown
  activeUserActionCardIds?: readonly string[]
  onResolveUserActionCard?: (request: UserActionCardResult) => void | Promise<void>
  onTranslateThinkingBlock?: (request: {
    messageId: string
    blockIndex: number
    text: string
  }) => Promise<void>
  activityLeadingElement?: LooseOptional<ReactElement>
  activityTrailingElement?: LooseOptional<ReactElement>
  goalCompletionSummary?: LooseOptional<GoalCompletionActivitySummary>
  renderAfterToolCall?: (block: ToolCallBlockType) => Nullable<ReactNode>
}): ReactElement {
  const { locale } = useConversationI18n()
  const translatorRuntime = useConversationTranslatorRuntime()
  const recentlyStreamingMessageIdRef = useRef<Nullable<string>>(null)
  const shouldRevealStreamingText =
    isStreaming || recentlyStreamingMessageIdRef.current === messageId

  useEffect(() => {
    if (isStreaming) {
      recentlyStreamingMessageIdRef.current = messageId
      return
    }

    if (recentlyStreamingMessageIdRef.current === messageId) {
      recentlyStreamingMessageIdRef.current = null
    }
  }, [isStreaming, messageId])

  useEffect(() => {
    if (!isStreaming) return

    void preloadToolActivityRenderer()
  }, [isStreaming])

  // 串行传播由状态层保证：ChatStreamPacer 把思考/正文/工具归并成单 FIFO 按到达顺序逐帧吐进
  // session，思考中途的工具调用会截断思考块、后续思考在工具卡下方新开一块（见
  // chatStreamTextState 的相邻合并判定）。组件直接渲染状态文本，不再有落后于状态的影子揭示，
  // 因此无需任何"隐藏下方内容"的门控。
  const visibleMessageRenderSegments = messageRenderSegments

  const responseDurationMs = useMemo(
    () =>
      getAssistantResponseDurationMs({
        questionMessage,
        runMarker,
        isStreaming,
      }),
    [isStreaming, questionMessage, runMarker]
  )
  const shouldUseProcessedActivityBoundary = useMemo(
    () =>
      shouldUseProcessedActivitySummaryBoundary({
        isStreaming,
        runMarker,
      }),
    [isStreaming, runMarker]
  )
  const processedActivitySummaryBoundaryIndex = useMemo(
    () =>
      shouldUseProcessedActivityBoundary
        ? getProcessedActivitySummaryBoundaryIndex(visibleMessageRenderSegments)
        : -1,
    [shouldUseProcessedActivityBoundary, visibleMessageRenderSegments]
  )
  const hasFinalSummaryText =
    shouldUseProcessedActivityBoundary && processedActivitySummaryBoundaryIndex >= 0
  const shouldAutoCollapseProcessedActivity =
    !isStreaming && recentlyStreamingMessageIdRef.current === messageId
  const segmentSuffixStates = useMemo(
    () => buildMessageSegmentSuffixStates(visibleMessageRenderSegments),
    [visibleMessageRenderSegments]
  )
  const renderAfterToolCallElements = (
    segment: MessageRenderSegment,
    keyPrefix: string
  ): ReactNode[] => {
    if (!renderAfterToolCall) return []

    const toolCallBlocks: ToolCallBlockType[] = []
    collectToolCallBlocksFromMessageRenderSegment(segment, toolCallBlocks)

    return toolCallBlocks.flatMap((block) => {
      const element = renderAfterToolCall(block)

      return isPresent(element)
        ? [
            <React.Fragment key={`${keyPrefix}:after-tool:${block.toolCallId}`}>
              {element}
            </React.Fragment>,
          ]
        : []
    })
  }

  const renderToolRenderSegment = (
    segment: ToolRenderSegment,
    options: { autoCollapseThinking?: boolean } = {}
  ): Nullable<ReactElement> => {
    switch (segment.kind) {
      case 'tool-group':
        return (
          <ToolCallGroup
            key={segment.key}
            blocks={segment.blocks}
            sessionId={sessionId}
            planUpdateIndexByToolCallId={planUpdateIndexByToolCallId}
            formatPathForDisplay={formatPathForDisplay}
          />
        )
      case 'merged-tool':
        return (
          <MergedToolCallRow
            key={segment.key}
            group={segment.group}
            sessionId={sessionId}
            planUpdateIndexByToolCallId={planUpdateIndexByToolCallId}
            formatPathForDisplay={formatPathForDisplay}
          />
        )
      case 'block':
        break
    }

    const planUpdateIndex = optionalWhenLazy(segment.block.type === 'tool-call', () =>
      planUpdateIndexByToolCallId?.get(
        (segment.block as Extract<ContentBlock, { type: 'tool-call' }>).toolCallId
      )
    )

    return (
      <MessageContentBlock
        key={segment.key}
        block={segment.block}
        isStreaming={isStreaming}
        autoCollapseThinking={options.autoCollapseThinking}
        animateStreamingText={shouldRevealStreamingText && segment.key === streamingTextSegmentKey}
        sessionId={sessionId}
        messageId={messageId}
        runMarker={
          !isStreaming && runMarker && segment.key === lastTextSegmentKey ? runMarker : null
        }
        planUpdateIndex={planUpdateIndex}
        blockIndex={getBlockIndex?.(segment.block)}
        formatPathForDisplay={formatPathForDisplay}
        onOpenBrowserLink={onOpenBrowserLink}
        onOpenProjectPath={onOpenProjectPath}
        activeUserActionCardIds={activeUserActionCardIds}
        onResolveUserActionCard={onResolveUserActionCard}
        onTranslateThinkingBlock={onTranslateThinkingBlock}
      />
    )
  }

  const shouldRenderInlineActivitySegment = (
    segment: MessageRenderSegment,
    index: number
  ): boolean => {
    const suffixState = segmentSuffixStates[index] ?? EmptyMessageSegmentSuffixState

    if (isStreaming && messageSegmentStartsThinking(segment)) return false

    if (segment.kind === 'activity-group')
      return !isStreaming || suffixState.hasStartedTextAfter || suffixState.hasStartedThinkingAfter

    return (
      messageSegmentStartsThinking(segment) &&
      (!isStreaming || suffixState.hasStartedTextAfter || suffixState.hasStartedToolActivityAfter)
    )
  }

  const renderMessageRenderSegment = (segment: MessageRenderSegment): Nullable<ReactElement> => {
    if (segment.kind !== 'activity-group') return renderToolRenderSegment(segment.segment)

    const renderActivityGroupChildren = (): ReactNode[] =>
      segment.segments.map((childSegment) => renderToolRenderSegment(childSegment))

    return shouldRenderActivityGroupDisclosure(segment) ? (
      <ToolActivityDisclosure
        key={segment.key}
        blocks={segment.blocks}
        defaultExpanded={isStreaming}
      >
        {() => renderActivityGroupChildren()}
      </ToolActivityDisclosure>
    ) : (
      <React.Fragment key={segment.key}>{renderActivityGroupChildren()}</React.Fragment>
    )
  }

  const renderAssistantSegments = (): ReactNode[] => {
    const renderedSegments: ReactNode[] = []
    let inlineActivityRenderers: ActivitySegmentRenderer[] = []
    let inlineActivityBlocks: ToolCallBlockType[] = []
    let inlineActivityAfterToolCallElements: ReactNode[] = []
    let inlineActivityKey: Nullable<string> = null
    let trailingActivityElementRendered = false

    const pushAfterToolCallElements = (segment: MessageRenderSegment): void => {
      renderedSegments.push(
        ...renderAfterToolCallElements(segment, `message-segment:${segment.key}`)
      )
    }

    if (!hasFinalSummaryText && activityLeadingElement) {
      renderedSegments.push(
        <React.Fragment key="activity-leading">{activityLeadingElement}</React.Fragment>
      )
    }

    const flushInlineActivitySegments = (options: { includeTrailing?: boolean } = {}): void => {
      const renderers = [...inlineActivityRenderers]
      const blocks = [...inlineActivityBlocks]
      const afterToolCallElements = [...inlineActivityAfterToolCallElements]
      const key = inlineActivityKey
      const includeTrailingElement = !!(
        options.includeTrailing &&
        activityTrailingElement &&
        !trailingActivityElementRendered
      )

      if (isEmpty(renderers) && !includeTrailingElement && isEmpty(afterToolCallElements)) return

      if (includeTrailingElement) {
        trailingActivityElementRendered = true
      }

      inlineActivityRenderers = []
      inlineActivityBlocks = []
      inlineActivityAfterToolCallElements = []
      inlineActivityKey = null

      const renderSegments = (): ReactNode[] => {
        const segments = renderers.map((renderSegment) => renderSegment()).filter(isPresent)

        if (includeTrailingElement && activityTrailingElement) {
          segments.push(
            <React.Fragment key="activity-trailing">{activityTrailingElement}</React.Fragment>
          )
        }

        return segments
      }

      if (hasFinalSummaryText) {
        renderedSegments.push(
          <ToolActivityDisclosure
            key={`processed-activity:${key ?? renderedSegments.length}`}
            blocks={blocks}
            autoCollapseOnMount={shouldAutoCollapseProcessedActivity}
            label={getProcessedActivityDisclosureLabel(blocks, locale, {
              goalCompletionSummary,
              responseDurationMs,
            }, translatorRuntime)}
            isRunning={false}
          >
            {() => renderSegments()}
          </ToolActivityDisclosure>
        )
        renderedSegments.push(...afterToolCallElements)
        return
      }

      const segments = renderSegments()
      if (isEmpty(segments)) {
        renderedSegments.push(...afterToolCallElements)
        return
      }

      if (segments.length === 1) {
        renderedSegments.push(segments[0])
        renderedSegments.push(...afterToolCallElements)
        return
      }

      renderedSegments.push(
        <div
          key={`activity-row:${key ?? renderedSegments.length}`}
          className={styles.toolActivitySummaryRow}
        >
          {segments}
        </div>
      )
      renderedSegments.push(...afterToolCallElements)
    }

    if (hasFinalSummaryText) {
      const { processedSegments, outsideSegments, trailingSegments } =
        partitionProcessedActivitySummarySegments(
          visibleMessageRenderSegments,
          processedActivitySummaryBoundaryIndex
        )
      const outsideSegmentKeys = new Set(outsideSegments.map((segment) => segment.key))
      const processedSegmentKeys = new Set(processedSegments.map((segment) => segment.key))
      const processedActivityRenderers: ActivitySegmentRenderer[] = []
      const processedActivityBlocks: ToolCallBlockType[] = []
      const postDisclosureElements: ReactNode[] = []

      visibleMessageRenderSegments.forEach((segment) => {
        if (processedSegmentKeys.has(segment.key)) {
          processedActivityRenderers.push(() => renderMessageRenderSegment(segment))
          collectToolCallBlocksFromMessageRenderSegment(segment, processedActivityBlocks)
        } else if (outsideSegmentKeys.has(segment.key)) {
          const renderedSegment = renderMessageRenderSegment(segment)
          if (renderedSegment) postDisclosureElements.push(renderedSegment)
        } else {
          return
        }

        postDisclosureElements.push(
          ...renderAfterToolCallElements(segment, `processed-segment:${segment.key}`)
        )
      })

      const includeLeadingElement = !!activityLeadingElement
      if (!isEmpty(processedActivityRenderers) || includeLeadingElement) {
        const firstProcessedKey = processedSegments[0]?.key ?? 'leading'
        renderedSegments.push(
          <ToolActivityDisclosure
            key={`processed-activity:${firstProcessedKey}`}
            blocks={processedActivityBlocks}
            autoCollapseOnMount={shouldAutoCollapseProcessedActivity}
            label={getProcessedActivityDisclosureLabel(processedActivityBlocks, locale, {
              goalCompletionSummary,
              responseDurationMs,
            }, translatorRuntime)}
            isRunning={false}
          >
            {() => [
              ...(activityLeadingElement
                ? [<React.Fragment key="activity-leading">{activityLeadingElement}</React.Fragment>]
                : []),
              ...processedActivityRenderers
                .map((renderSegment) => renderSegment())
                .filter(isPresent),
              ...(activityTrailingElement
                ? [
                    <React.Fragment key="activity-trailing">
                      {activityTrailingElement}
                    </React.Fragment>,
                  ]
                : []),
            ]}
          </ToolActivityDisclosure>
        )
      }

      // 所有从「已处理」提出来的卡片和工具锚点统一落在唯一分组下方。
      renderedSegments.push(...postDisclosureElements)
      trailingSegments.forEach((segment) => {
        const renderedSegment = renderMessageRenderSegment(segment)
        if (renderedSegment) renderedSegments.push(renderedSegment)
        pushAfterToolCallElements(segment)
      })
      return renderedSegments
    }

    visibleMessageRenderSegments.forEach((segment, index) => {
      if (shouldRenderInlineActivitySegment(segment, index)) {
        inlineActivityKey ??= segment.key
        inlineActivityRenderers.push(() => renderMessageRenderSegment(segment))
        collectToolCallBlocksFromMessageRenderSegment(segment, inlineActivityBlocks)
        inlineActivityAfterToolCallElements.push(
          ...renderAfterToolCallElements(segment, `inline-segment:${segment.key}`)
        )
        return
      }

      const renderedSegment = renderMessageRenderSegment(segment)
      if (!renderedSegment) return

      flushInlineActivitySegments({
        includeTrailing: !isEmpty(inlineActivityRenderers),
      })
      renderedSegments.push(renderedSegment)
      pushAfterToolCallElements(segment)
    })

    flushInlineActivitySegments({ includeTrailing: true })
    return renderedSegments
  }

  return <div className={styles.assistantSegments}>{renderAssistantSegments()}</div>
}

export const AssistantMessageSegments = memo(AssistantMessageSegmentsInner)

AssistantMessageSegments.displayName = 'AssistantMessageSegments'
