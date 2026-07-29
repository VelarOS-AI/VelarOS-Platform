/**
 * 聊天转录窗口：按对话节切片渲染，并提供导航引用。
 *
 * 取代旧的整列表虚拟化：只把可见消息中的一个「窗口」切片交给转录区全量渲染，
 * 窗口边界对齐用户消息。右侧滚动导航通过导航引用驱动窗口：
 *   - 上一节/下一节：窗口内走页面节点滚动；到达窗口边界时按对话节滑动窗口
 *   - 回顶：滑到已加载顶部；已在顶部且磁盘还有更旧消息时触发加载更旧消息
 *   - 到底：回到末尾窗口并重新跟随（流式贴底由 useScrollToBottom 负责）
 *
 * 流式「在底部才跟随」由滚动钩子在页面节点层处理，这里不重复实现。
 */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLatest } from 'ahooks'

import {
  resolveSectionNavigationTargetTop,
  type SectionMetric,
} from '../react-hooks/scrollBehavior'

import type { ChatTranscriptNavigationHandle } from './ChatTranscript'

import type { ChatMessage } from '#contracts'
import { isEmpty, isNumber } from '#internal/runtime'

/** 单窗口渲染的消息条数预算（按对话节边界向上取整，单个超大对话节仍整段渲染）。 */
const WindowMessageBudget = 60
const SectionSnapThreshold = 12
const ScrollEdgeThreshold = 8

interface UseChatTranscriptWindowOptions {
  messages: ChatMessage[]
  sessionId: string
  scrollRef: RefObject<Nullable<HTMLDivElement>>
  transcriptNavigationRef: RefObject<Nullable<ChatTranscriptNavigationHandle>>
  pinnedMessageId?: LooseOptional<string>
  hasOlderMessages?: boolean
  onLoadOlderMessages?: () => void
}

export interface UseChatTranscriptWindowReturn {
  windowMessages: ChatMessage[]
  /** 窗口起点已是已加载历史的最顶端：此时顶部哨兵可触发磁盘加载更旧消息。 */
  isWindowAtLoadedTop: boolean
}

type PendingScroll =
  | { kind: 'bottom' }
  | { kind: 'top' }
  | { kind: 'section'; messageId: string }

interface TranscriptWindowState {
  /** true 时窗口锚定末尾，跟随新消息。 */
  followEnd: boolean
  /** !followEnd 时窗口起始的 section 锚点（消息下标，会被规整到最近的 section 边界）。 */
  anchorIndex: number
  /** 用于强制重跑 pending 滚动副作用（即使窗口边界未变）。 */
  nonce: number
}

interface WindowRange {
  startIndex: number
  endIndex: number
}

export interface ChatTranscriptWindowAnchorState {
  followEnd: boolean
  anchorIndex: number
}

const InitialWindowState: TranscriptWindowState = { followEnd: true, anchorIndex: 0, nonce: 0 }

/** user 消息所在下标即 section 起点；首条非 user 时补 0，使开头那段也算一个 section。 */
function computeSectionStarts(messages: ChatMessage[]): number[] {
  const starts: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'user') starts.push(index)
  })
  if (isEmpty(starts) || starts[0] !== 0) starts.unshift(0)

  return starts
}

/** 最近的、<= index 的 section 起点。 */
function snapToSectionStart(sectionStarts: number[], index: number): number {
  let snapped = sectionStarts[0] ?? 0
  for (const start of sectionStarts) {
    if (start <= index) snapped = start
    else break
  }

  return snapped
}

function previousSectionStart(sectionStarts: number[], startIndex: number): number {
  let previous = sectionStarts[0] ?? 0
  for (const start of sectionStarts) {
    if (start < startIndex) previous = start
    else break
  }

  return previous
}

function deriveWindowRange(
  total: number,
  sectionStarts: number[],
  state: TranscriptWindowState
): WindowRange {
  if (total === 0) return { startIndex: 0, endIndex: 0 }

  if (state.followEnd) {
    let startIndex = sectionStarts[0] ?? 0
    for (const start of sectionStarts) {
      if (total - start <= WindowMessageBudget) {
        startIndex = start
        break
      }
      startIndex = start
    }
    // 末尾单个 section 已超预算时，至少完整渲染它。
    const lastStart = sectionStarts.at(-1) ?? 0
    if (total - startIndex > WindowMessageBudget) startIndex = lastStart

    return { startIndex, endIndex: total }
  }

  const startIndex = snapToSectionStart(sectionStarts, Math.min(state.anchorIndex, total - 1))
  let endIndex = total
  for (const start of sectionStarts) {
    if (start > startIndex && start - startIndex >= WindowMessageBudget) {
      endIndex = start
      break
    }
  }

  return { startIndex, endIndex }
}

function extendWindowRangeToIncludeMessage(
  range: WindowRange,
  messageIndex: number,
  sectionStarts: number[]
): WindowRange {
  if (messageIndex < 0) return range
  if (messageIndex >= range.startIndex && messageIndex < range.endIndex) return range

  if (messageIndex < range.startIndex) return {
      startIndex: snapToSectionStart(sectionStarts, messageIndex),
      endIndex: range.endIndex,
    }

  return {
    startIndex: range.startIndex,
    endIndex: messageIndex + 1,
  }
}

export function resolveChatTranscriptWindowMessages({
  messages,
  state,
  pinnedMessageId,
}: {
  messages: ChatMessage[]
  state: ChatTranscriptWindowAnchorState
  pinnedMessageId?: LooseOptional<string>
}): ChatMessage[] {
  const sectionStarts = computeSectionStarts(messages)
  const baseRange = deriveWindowRange(messages.length, sectionStarts, {
    followEnd: state.followEnd,
    anchorIndex: state.anchorIndex,
    nonce: 0,
  })
  const pinnedMessageIndex = pinnedMessageId
    ? messages.findIndex((message) => message.id === pinnedMessageId)
    : -1
  const range = extendWindowRangeToIncludeMessage(
    baseRange,
    pinnedMessageIndex,
    sectionStarts
  )

  return messages.slice(range.startIndex, range.endIndex)
}

/** 当前已渲染窗口内的 user section 顶部位置（相对滚动容器）。 */
function collectRenderedSectionTops(scrollEl: HTMLDivElement): SectionMetric[] {
  const containerTop = scrollEl.getBoundingClientRect().top
  const metrics: SectionMetric[] = []
  const nodes = scrollEl.querySelectorAll<HTMLElement>(
    '[data-message-id][data-message-role="user"]'
  )
  for (const node of nodes) {
    if (node.offsetHeight <= 0) continue
    metrics.push({ top: node.getBoundingClientRect().top - containerTop + scrollEl.scrollTop })
  }

  return metrics
}

export function useChatTranscriptWindow({
  messages,
  sessionId,
  scrollRef,
  transcriptNavigationRef,
  pinnedMessageId = null,
  hasOlderMessages = false,
  onLoadOlderMessages,
}: UseChatTranscriptWindowOptions): UseChatTranscriptWindowReturn {
  const [state, setState] = useState<TranscriptWindowState>(InitialWindowState)
  const pendingScrollRef = useRef<Nullable<PendingScroll>>(null)
  // member=session：会话即工作区，transcript 窗口 scope key 就是 sessionId。
  const transcriptWindowScopeKey = sessionId

  const sectionStarts = useMemo(() => computeSectionStarts(messages), [messages])
  const range = useMemo(
    () => {
      const baseRange = deriveWindowRange(messages.length, sectionStarts, state)
      const pinnedMessageIndex = pinnedMessageId
        ? messages.findIndex((message) => message.id === pinnedMessageId)
        : -1

      return extendWindowRangeToIncludeMessage(baseRange, pinnedMessageIndex, sectionStarts)
    },
    [messages, pinnedMessageId, sectionStarts, state]
  )
  const windowMessages = useMemo(
    () => messages.slice(range.startIndex, range.endIndex),
    [messages, range.startIndex, range.endIndex]
  )

  const messagesRef = useLatest(messages)
  const sectionStartsRef = useLatest(sectionStarts)
  const rangeRef = useLatest(range)
  const hasOlderRef = useLatest(hasOlderMessages)
  const loadOlderRef = useLatest(onLoadOlderMessages)

  // 切换会话或 workspace context 时重置为末尾跟随窗口。
  useEffect(() => {
    pendingScrollRef.current = null
    setState(InitialWindowState)
  }, [transcriptWindowScopeKey])

  const queueScroll = useCallback(
    (pending: PendingScroll, next: Partial<TranscriptWindowState>): void => {
      pendingScrollRef.current = pending
      setState((current) => ({
        followEnd: next.followEnd ?? current.followEnd,
        anchorIndex: next.anchorIndex ?? current.anchorIndex,
        nonce: current.nonce + 1,
      }))
    },
    []
  )

  // 应用窗口切换后的滚动定位。
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current
    if (!pending) return
    pendingScrollRef.current = null

    const scrollEl = scrollRef.current
    if (!scrollEl) return

    if (pending.kind === 'bottom') {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'auto' })
      return
    }
    if (pending.kind === 'top') {
      scrollEl.scrollTo({ top: 0, behavior: 'auto' })
      return
    }

    const node = scrollEl.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(pending.messageId)}"]`
    )
    if (!node) return

    const top = node.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
    scrollEl.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
  }, [range.startIndex, range.endIndex, state.nonce, scrollRef])

  const navigationHandle = useMemo<ChatTranscriptNavigationHandle>(
    () => ({
      getSectionMetrics: () => [],
      getSectionState: () => {
        const scrollEl = scrollRef.current
        if (!scrollEl) return { hasPreviousSection: false, hasNextSection: false }

        const atTop = scrollEl.scrollTop <= ScrollEdgeThreshold
        const atBottom =
          scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - ScrollEdgeThreshold
        const { startIndex, endIndex } = rangeRef.current

        return {
          hasPreviousSection: !atTop || startIndex > 0 || hasOlderRef.current,
          hasNextSection: !atBottom || endIndex < messagesRef.current.length,
        }
      },
      scrollToSection: (direction) => {
        const scrollEl = scrollRef.current
        if (!scrollEl) return false

        const metrics = collectRenderedSectionTops(scrollEl)
        const maxScrollTop = Math.max(scrollEl.scrollHeight - scrollEl.clientHeight, 0)
        const targetTop = resolveSectionNavigationTargetTop({
          direction,
          currentScrollTop: scrollEl.scrollTop,
          maxScrollTop,
          metrics,
          snapThreshold: SectionSnapThreshold,
        })
        if (isNumber(targetTop)) {
          scrollEl.scrollTo({ top: targetTop, behavior: 'smooth' })
          return true
        }

        // 已到窗口边界：按 section 滑动窗口。
        const { startIndex, endIndex } = rangeRef.current
        const total = messagesRef.current.length

        if (direction === 'previous') {
          if (startIndex > 0) {
            const nextStart = previousSectionStart(sectionStartsRef.current, startIndex)
            queueScroll(
              { kind: 'section', messageId: messagesRef.current[nextStart].id },
              { followEnd: false, anchorIndex: nextStart }
            )
            return true
          }
          if (hasOlderRef.current) {
            loadOlderRef.current?.()
            return true
          }
          return false
        }

        if (endIndex < total) {
          queueScroll(
            { kind: 'section', messageId: messagesRef.current[endIndex].id },
            { followEnd: false, anchorIndex: endIndex }
          )
          return true
        }
        return false
      },
      scrollToEdge: (edge) => {
        if (edge === 'bottom') {
          queueScroll({ kind: 'bottom' }, { followEnd: true, anchorIndex: 0 })
          return true
        }

        const { startIndex } = rangeRef.current
        if (startIndex > 0) {
          queueScroll({ kind: 'top' }, { followEnd: false, anchorIndex: 0 })
          if (hasOlderRef.current) loadOlderRef.current?.()
          return true
        }
        if (hasOlderRef.current) {
          loadOlderRef.current?.()
          queueScroll({ kind: 'top' }, {})
          return true
        }
        return false
      },
    }),
    [hasOlderRef, loadOlderRef, messagesRef, queueScroll, rangeRef, scrollRef, sectionStartsRef]
  )

  useEffect(() => {
    transcriptNavigationRef.current = navigationHandle

    return () => {
      if (transcriptNavigationRef.current === navigationHandle) {
        transcriptNavigationRef.current = null
      }
    }
  }, [navigationHandle, transcriptNavigationRef])

  return {
    windowMessages,
    isWindowAtLoadedTop: range.startIndex === 0,
  }
}
