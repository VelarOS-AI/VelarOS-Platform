import React, {
  memo,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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

export function shouldRenderActivityGroupDisclosure(
  segment: MessageRenderSegment,
  isStreaming: boolean
): boolean {
  return !isStreaming && segment.kind === 'activity-group' && !isEmpty(segment.blocks)
}

/** 完成态「已处理」内部只有真正的折叠项参与连续横排；正文和卡片仍各自占行。 */
export function shouldGroupProcessedActivityDisclosure(
  segment: MessageRenderSegment
): boolean {
  return (
    shouldRenderActivityGroupDisclosure(segment, false) || messageSegmentStartsThinking(segment)
  )
}

export function shouldAnimateLiveToolActivity({
  armedMessageId,
  isStreaming,
  messageId,
}: {
  armedMessageId: Nullable<string>
  isStreaming: boolean
  messageId: string
}): boolean {
  return isStreaming && armedMessageId === messageId
}

export function shouldRenderProcessedActivityDisclosure({
  hasFinalSummaryText,
  hasGroupedRunActivity,
  shouldUseProcessedActivityBoundary,
}: {
  hasFinalSummaryText: boolean
  hasGroupedRunActivity: boolean
  shouldUseProcessedActivityBoundary: boolean
}): boolean {
  return (
    hasFinalSummaryText || (hasGroupedRunActivity && shouldUseProcessedActivityBoundary)
  )
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
  implicitlyCompletedRun = false,
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
  hasGroupedRunActivity = false,
  goalCompletionSummary = null,
  questionMessage = null,
  renderAfterToolCall,
}: {
  messageRenderSegments: MessageRenderSegment[]
  isStreaming: boolean
  implicitlyCompletedRun?: boolean
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
  hasGroupedRunActivity?: boolean
  goalCompletionSummary?: LooseOptional<GoalCompletionActivitySummary>
  renderAfterToolCall?: (block: ToolCallBlockType) => Nullable<ReactNode>
}): ReactElement {
  const { locale } = useConversationI18n()
  const translatorRuntime = useConversationTranslatorRuntime()
  const recentlyStreamingMessageIdRef = useRef<Nullable<string>>(null)
  const [toolMotionArmedMessageId, setToolMotionArmedMessageId] = useState<Nullable<string>>(null)
  const animateLiveToolActivity = shouldAnimateLiveToolActivity({
    armedMessageId: toolMotionArmedMessageId,
    isStreaming,
    messageId,
  })
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

  // 首次挂载（含切回仍在运行的会话）先让现有工具卡提交并登记 revision，再武装后续入场动画。
  // layout effect 的同步二次渲染发生在浏览器绘制前，因此旧卡不会在重挂载时集体重播；
  // 此后真正新到达的 toolCallId 仍会正常播放一次入场。
  useLayoutEffect(() => {
    setToolMotionArmedMessageId(isStreaming ? messageId : null)
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
      implicitlyCompletedRun ||
      shouldUseProcessedActivitySummaryBoundary({
        isStreaming,
        runMarker,
      }),
    [implicitlyCompletedRun, isStreaming, runMarker]
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
  const shouldRenderProcessedActivity = shouldRenderProcessedActivityDisclosure({
    hasFinalSummaryText,
    hasGroupedRunActivity,
    shouldUseProcessedActivityBoundary,
  })
  const processedActivityBoundaryIndex = hasFinalSummaryText
    ? processedActivitySummaryBoundaryIndex
    : visibleMessageRenderSegments.length
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
            animateLiveToolActivity={animateLiveToolActivity}
            messageId={messageId}
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
            animateLiveToolActivity={animateLiveToolActivity}
            messageId={messageId}
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
        blockAnimationKey={segment.key}
        animateLiveToolActivity={animateLiveToolActivity}
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

    if (isStreaming)
      return (
        <div key={segment.key} className={styles.liveToolActivityGroup}>
          {renderActivityGroupChildren()}
        </div>
      )

    return shouldRenderActivityGroupDisclosure(segment, isStreaming) ? (
      <ToolActivityDisclosure
        key={segment.key}
        blocks={segment.blocks}
        autoCollapseAfterPaint={shouldAutoCollapseProcessedActivity}
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

    const pushAfterToolCallElements = (segment: MessageRenderSegment): void => {
      renderedSegments.push(
        ...renderAfterToolCallElements(segment, `message-segment:${segment.key}`)
      )
    }

    if (!shouldRenderProcessedActivity && activityLeadingElement) {
      renderedSegments.push(
        <React.Fragment key="activity-leading">{activityLeadingElement}</React.Fragment>
      )
    }

    const flushInlineActivitySegments = (): void => {
      const renderers = [...inlineActivityRenderers]
      const blocks = [...inlineActivityBlocks]
      const afterToolCallElements = [...inlineActivityAfterToolCallElements]
      const key = inlineActivityKey

      if (isEmpty(renderers) && isEmpty(afterToolCallElements)) return

      inlineActivityRenderers = []
      inlineActivityBlocks = []
      inlineActivityAfterToolCallElements = []
      inlineActivityKey = null

      const renderSegments = (): ReactNode[] =>
        renderers.map((renderSegment) => renderSegment()).filter(isPresent)

      if (shouldRenderProcessedActivity) {
        renderedSegments.push(
          <ToolActivityDisclosure
            key={`processed-activity:${key ?? renderedSegments.length}`}
            blocks={blocks}
            autoCollapseAfterPaint={shouldAutoCollapseProcessedActivity}
            label={getProcessedActivityDisclosureLabel(
              blocks,
              locale,
              {
                goalCompletionSummary,
                responseDurationMs,
              },
              translatorRuntime
            )}
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

    if (shouldRenderProcessedActivity) {
      const { processedSegments, outsideSegments, trailingSegments } =
        partitionProcessedActivitySummarySegments(
          visibleMessageRenderSegments,
          processedActivityBoundaryIndex
        )
      const outsideSegmentKeys = new Set(outsideSegments.map((segment) => segment.key))
      const processedSegmentKeys = new Set(processedSegments.map((segment) => segment.key))
      const processedActivityEntries: Array<{
        segment: MessageRenderSegment
        render: ActivitySegmentRenderer
      }> = []
      const processedActivityBlocks: ToolCallBlockType[] = []
      const postDisclosureElements: ReactNode[] = []

      visibleMessageRenderSegments.forEach((segment) => {
        if (processedSegmentKeys.has(segment.key)) {
          processedActivityEntries.push({
            segment,
            render: () => renderMessageRenderSegment(segment),
          })
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

      const renderProcessedActivityEntries = (): ReactNode[] => {
        const elements: ReactNode[] = []
        let inlineElements: ReactElement[] = []
        let inlineKey: Nullable<string> = null

        const flushInlineElements = (): void => {
          if (isEmpty(inlineElements)) return

          if (inlineElements.length === 1) {
            elements.push(inlineElements[0])
          } else {
            elements.push(
              <div
                key={`processed-activity-row:${inlineKey ?? elements.length}`}
                className={styles.toolActivitySummaryRow}
              >
                {inlineElements}
              </div>
            )
          }

          inlineElements = []
          inlineKey = null
        }

        processedActivityEntries.forEach(({ segment, render }) => {
          const element = render()
          if (!element) return

          if (shouldGroupProcessedActivityDisclosure(segment)) {
            inlineKey ??= segment.key
            inlineElements.push(element)
            return
          }

          flushInlineElements()
          elements.push(element)
        })

        flushInlineElements()
        return elements
      }

      const includeLeadingElement = !!activityLeadingElement
      if (!isEmpty(processedActivityEntries) || includeLeadingElement) {
        const firstProcessedKey = processedSegments[0]?.key ?? 'leading'
        renderedSegments.push(
          <ToolActivityDisclosure
            key={`processed-activity:${firstProcessedKey}`}
            blocks={processedActivityBlocks}
            autoCollapseAfterPaint={shouldAutoCollapseProcessedActivity}
            label={getProcessedActivityDisclosureLabel(
              processedActivityBlocks,
              locale,
              {
                goalCompletionSummary,
                responseDurationMs,
              },
              translatorRuntime
            )}
            isRunning={false}
          >
            {() => [
              ...(activityLeadingElement
                ? [<React.Fragment key="activity-leading">{activityLeadingElement}</React.Fragment>]
                : []),
              ...renderProcessedActivityEntries(),
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
      if (activityTrailingElement) {
        renderedSegments.push(
          <React.Fragment key="activity-trailing">{activityTrailingElement}</React.Fragment>
        )
      }
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

      flushInlineActivitySegments()
      renderedSegments.push(renderedSegment)
      pushAfterToolCallElements(segment)
    })

    flushInlineActivitySegments()
    if (activityTrailingElement) {
      renderedSegments.push(
        <React.Fragment key="activity-trailing">{activityTrailingElement}</React.Fragment>
      )
    }
    return renderedSegments
  }

  return <div className={styles.assistantSegments}>{renderAssistantSegments()}</div>
}

export const AssistantMessageSegments = memo(AssistantMessageSegmentsInner)

AssistantMessageSegments.displayName = 'AssistantMessageSegments'
