import { memo, type ReactElement, type RefObject, useCallback, useEffect, useState } from 'react'
import {
  ArrowLineDownIcon,
  ArrowLineUpIcon,
  CaretDownIcon,
  CaretUpIcon,
  TargetIcon,
} from '@phosphor-icons/react'
import { useEventListener } from 'ahooks'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import { useConversationI18n } from '../i18n'
import {
  findNextSectionTop,
  findPreviousSectionTop,
  resolveSectionNavigationTargetTop,
  type SectionMetric,
} from '../react-hooks/scrollBehavior'

import type { ChatTranscriptNavigationHandle } from './ChatTranscript'
import { useRafSchedule } from './useRafSchedule'

import styles from './ChatScrollNavigator.module.css'

import { isEmpty, isNumber } from '#internal/runtime'

const SCROLL_EDGE_THRESHOLD = 8
const SECTION_SNAP_THRESHOLD = 12

interface ChatScrollNavigatorProps {
  followLocked: boolean
  onFollowLockedChange: (locked: boolean) => void
  scrollRef: RefObject<Nullable<HTMLDivElement>>
  transcriptNavigationRef?: RefObject<Nullable<ChatTranscriptNavigationHandle>>
}

interface ScrollNavigatorState {
  visible: boolean
  isAtTop: boolean
  isAtBottom: boolean
  hasPreviousSection: boolean
  hasNextSection: boolean
}

const EMPTY_NAVIGATOR_STATE: ScrollNavigatorState = {
  visible: false,
  isAtTop: true,
  isAtBottom: true,
  hasPreviousSection: false,
  hasNextSection: false,
}

function collectDomSectionMetrics(scrollEl: HTMLDivElement): SectionMetric[] {
  const containerRect = scrollEl.getBoundingClientRect()
  const metrics: SectionMetric[] = []
  const nodes = scrollEl.querySelectorAll<HTMLElement>(
    '[data-message-id][data-message-role="user"]'
  )

  for (const node of nodes) {
    if (!node.dataset.messageId || node.offsetHeight <= 0) continue

    metrics.push({
      top: node.getBoundingClientRect().top - containerRect.top + scrollEl.scrollTop,
    })
  }

  return metrics
}

function getSectionMetrics(
  scrollEl: HTMLDivElement,
  transcriptNavigationRef?: RefObject<Nullable<ChatTranscriptNavigationHandle>>
): SectionMetric[] {
  return transcriptNavigationRef?.current?.getSectionMetrics() ?? collectDomSectionMetrics(scrollEl)
}

function getSectionState(
  scrollEl: HTMLDivElement,
  transcriptNavigationRef?: RefObject<Nullable<ChatTranscriptNavigationHandle>>
): Pick<ScrollNavigatorState, 'hasPreviousSection' | 'hasNextSection'> {
  const virtualState = transcriptNavigationRef?.current?.getSectionState()
  if (virtualState) return virtualState

  const metrics = getSectionMetrics(scrollEl, transcriptNavigationRef)
  const previousSectionTop = findPreviousSectionTop(
    metrics,
    scrollEl.scrollTop,
    SECTION_SNAP_THRESHOLD
  )
  const nextSectionTop = findNextSectionTop(metrics, scrollEl.scrollTop, SECTION_SNAP_THRESHOLD)

  return {
    hasPreviousSection: isNumber(previousSectionTop),
    hasNextSection: isNumber(nextSectionTop),
  }
}

function measureNavigatorState(
  scrollEl: HTMLDivElement,
  transcriptNavigationRef?: RefObject<Nullable<ChatTranscriptNavigationHandle>>
): ScrollNavigatorState {
  const canScroll = scrollEl.scrollHeight - scrollEl.clientHeight > SCROLL_EDGE_THRESHOLD
  const isAtTop = scrollEl.scrollTop <= SCROLL_EDGE_THRESHOLD
  const isAtBottom =
    scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - SCROLL_EDGE_THRESHOLD

  if (!canScroll) return EMPTY_NAVIGATOR_STATE

  const sectionState = getSectionState(scrollEl, transcriptNavigationRef)

  return {
    visible: canScroll,
    isAtTop,
    isAtBottom,
    ...sectionState,
  }
}

function isSameNavigatorState(prev: ScrollNavigatorState, next: ScrollNavigatorState): boolean {
  return (
    prev.visible === next.visible &&
    prev.isAtTop === next.isAtTop &&
    prev.isAtBottom === next.isAtBottom &&
    prev.hasPreviousSection === next.hasPreviousSection &&
    prev.hasNextSection === next.hasNextSection
  )
}

function ChatScrollNavigatorInner({
  followLocked,
  onFollowLockedChange,
  scrollRef,
  transcriptNavigationRef,
}: ChatScrollNavigatorProps): Nullable<ReactElement> {
  const { t } = useConversationI18n()
  const [navState, setNavState] = useState<ScrollNavigatorState>(EMPTY_NAVIGATOR_STATE)

  const refreshState = useCallback((): void => {
    const scrollEl = scrollRef.current
    if (!scrollEl) {
      setNavState((prev) =>
        isSameNavigatorState(prev, EMPTY_NAVIGATOR_STATE) ? prev : EMPTY_NAVIGATOR_STATE
      )
      return
    }

    const nextState = measureNavigatorState(scrollEl, transcriptNavigationRef)
    setNavState((prev) => (isSameNavigatorState(prev, nextState) ? prev : nextState))
  }, [scrollRef, transcriptNavigationRef])

  const scheduleRefresh = useRafSchedule(refreshState)

  useEventListener('resize', scheduleRefresh)
  useEventListener('scroll', scheduleRefresh, { target: scrollRef, passive: true })

  useEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return

    scheduleRefresh()

    const contentEl = scrollEl.firstElementChild
    const resizeObserver = new ResizeObserver(scheduleRefresh)
    resizeObserver.observe(scrollEl)
    if (contentEl) {
      resizeObserver.observe(contentEl)
    }

    return () => {
      resizeObserver.disconnect()
    }
  }, [refreshState, scrollRef, scheduleRefresh])

  const scrollToTop = useCallback((): void => {
    if (transcriptNavigationRef?.current?.scrollToEdge('top')) return

    const scrollEl = scrollRef.current
    if (!scrollEl) return

    // 回顶瞬时跳转：平滑滚动动画无收益，直接到位。
    scrollEl.scrollTo({ top: 0, behavior: 'auto' })
  }, [scrollRef, transcriptNavigationRef])

  const scrollToBottom = useCallback((): void => {
    if (transcriptNavigationRef?.current?.scrollToEdge('bottom')) return

    const scrollEl = scrollRef.current
    if (!scrollEl) return

    // 回底瞬时跳转：平滑滚动动画无收益，直接到位。
    scrollEl.scrollTo({
      top: scrollEl.scrollHeight - scrollEl.clientHeight,
      behavior: 'auto',
    })
  }, [scrollRef, transcriptNavigationRef])

  const jumpSection = useCallback(
    (direction: 'previous' | 'next'): void => {
      const scrollEl = scrollRef.current
      if (!scrollEl) return

      if (transcriptNavigationRef?.current?.scrollToSection(direction)) return

      const metrics = getSectionMetrics(scrollEl, transcriptNavigationRef)
      if (isEmpty(metrics)) return

      const maxScrollTop = Math.max(scrollEl.scrollHeight - scrollEl.clientHeight, 0)
      const targetTop = resolveSectionNavigationTargetTop({
        direction,
        currentScrollTop: scrollEl.scrollTop,
        maxScrollTop,
        metrics,
        snapThreshold: SECTION_SNAP_THRESHOLD,
      })
      if (!isNumber(targetTop)) return

      scrollEl.scrollTo({
        top: targetTop,
        behavior: 'smooth',
      })
    },
    [scrollRef, transcriptNavigationRef]
  )

  if (!navState.visible) return null

  return (
    <div className={styles.root}>
      <div className={styles.rail}>
        <IconButton
          label={t('chat.scrollToTop')}
          title={null}
          size="icon"
          shape="round"
          className={styles.button}
          onClick={scrollToTop}
          disabled={followLocked || navState.isAtTop}
        >
          <ArrowLineUpIcon size={16} weight="bold" />
        </IconButton>

        <IconButton
          label={t('chat.scrollToPreviousSection')}
          title={null}
          size="icon"
          shape="round"
          className={styles.button}
          onClick={() => {
            jumpSection('previous')
          }}
          disabled={followLocked || !navState.hasPreviousSection}
        >
          <CaretUpIcon size={16} weight="bold" />
        </IconButton>

        <IconButton
          label={t('chat.scrollToNextSection')}
          title={null}
          size="icon"
          shape="round"
          className={styles.button}
          onClick={() => {
            jumpSection('next')
          }}
          disabled={followLocked || !navState.hasNextSection}
        >
          <CaretDownIcon size={16} weight="bold" />
        </IconButton>

        <IconButton
          label={t('chat.scrollToBottom')}
          title={null}
          size="icon"
          shape="round"
          className={styles.button}
          onClick={scrollToBottom}
          disabled={followLocked || navState.isAtBottom}
        >
          <ArrowLineDownIcon size={16} weight="bold" />
        </IconButton>
      </div>

      <div className={styles.followLayer}>
        <IconButton
          label={t(followLocked ? 'chat.stopFollowing' : 'chat.keepFollowing')}
          title={null}
          size="icon"
          shape="round"
          className={`${styles.button} ${styles.followButton} ${followLocked ? styles.followButtonActive : ''}`}
          aria-pressed={followLocked}
          onClick={() => {
            onFollowLockedChange(!followLocked)
          }}
        >
          <TargetIcon size={17} weight={followLocked ? 'fill' : 'bold'} />
        </IconButton>
      </div>
    </div>
  )
}

export const ChatScrollNavigator = memo(ChatScrollNavigatorInner)

ChatScrollNavigator.displayName = 'ChatScrollNavigator'
