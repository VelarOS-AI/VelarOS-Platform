import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useEventListener } from 'ahooks'

import {
  AutoScrollSuspendEventName,
  resolveAutoScrollPinnedAfterReset,
  resolveAutoScrollPinnedAfterScroll,
  resolveAutoScrollWheelDecision,
  resolveRestoredScrollTop,
  shouldAutoScrollAfterContentResize,
  shouldCommitScheduledAutoScroll,
  shouldStartImmediateAutoScroll,
} from './scrollBehavior'
import { useTimerScope } from './useTimerScope'

import { isPresent } from '#internal/runtime'
import type { TimerLease } from '#internal/timerScope'

const AutoScrollThresholdPx = 24
const AtBottomThresholdPx = 2
const UpwardScrollTolerancePx = 1
const ContentGrowthUpwardTolerancePx = 48
const UnsetRestoreKey = Symbol('unset-scroll-restore-key')

export interface UseScrollToBottomOptions {
  restoreKey?: unknown
  readScrollTop?: () => Nullable<number>
  writeScrollTop?: (scrollTop: number) => void
}

export interface UseScrollToBottomReturn<T extends HTMLElement> {
  /** 强制持续跟随；普通的默认贴底不需要开启这一位。 */
  followLocked: boolean
  scrollRef: RefObject<Nullable<T>>
  setFollowLocked: (locked: boolean) => void
}

/**
 * 会话滚动的权威状态机。
 *
 * 默认会跟随新增内容，但 `followLocked` 默认关闭，因此用户滚轮、触控板或触摸滚动始终
 * 保留原生控制权。向上滚动会在浏览器改变 scrollTop 之前暂停贴底；真正回到底部或显式
 * 开启持续跟随后才恢复。内容增长只在仍处于 pinned 状态时贴底，避免流式 token 抢回滚动。
 */
export function useScrollToBottom<T extends HTMLElement>(
  trigger: unknown,
  resetKey: unknown = trigger,
  options: UseScrollToBottomOptions = {}
): UseScrollToBottomReturn<T> {
  const ref = useRef<T>(null)
  const followLockedRef = useRef(false)
  const [followLocked, setFollowLockedState] = useState(false)
  const shouldStickToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const lastResetKeyRef = useRef(resetKey)
  const lastRestoreKeyRef = useRef<unknown>(UnsetRestoreKey)
  const scrollTimers = useTimerScope('useScrollToBottom')
  const scrollFrameRef = useRef<Nullable<TimerLease>>(null)
  const pendingRestoreScrollTopRef = useRef<Nullable<number>>(null)
  const { readScrollTop, restoreKey, writeScrollTop } = options

  const isNearBottom = useCallback(
    (element: T): boolean =>
      element.scrollHeight - element.clientHeight - element.scrollTop <= AutoScrollThresholdPx,
    []
  )

  const isAtBottom = useCallback(
    (element: T): boolean =>
      element.scrollHeight - element.clientHeight - element.scrollTop <= AtBottomThresholdPx,
    []
  )

  const persistScrollTop = useCallback(
    (scrollTop: number): void => {
      writeScrollTop?.(Math.max(0, Math.floor(scrollTop)))
    },
    [writeScrollTop]
  )

  const applyRestoredScrollTop = useCallback(
    (element: T, scrollTop: number): boolean => {
      const maxScrollTop = Math.max(element.scrollHeight - element.clientHeight, 0)
      const restoredScrollTop = resolveRestoredScrollTop({ scrollTop, maxScrollTop })

      element.scrollTo({ top: restoredScrollTop.nextScrollTop, behavior: 'auto' })
      lastScrollTopRef.current = element.scrollTop
      pendingRestoreScrollTopRef.current = restoredScrollTop.pendingScrollTop

      if (!restoredScrollTop.shouldPersist) {
        shouldStickToBottomRef.current = false
        return true
      }

      shouldStickToBottomRef.current = isNearBottom(element)
      persistScrollTop(element.scrollTop)
      return true
    },
    [isNearBottom, persistScrollTop]
  )

  const restoreScrollTop = useCallback(
    (element: T): boolean => {
      const scrollTop = readScrollTop?.()
      return isPresent(scrollTop) ? applyRestoredScrollTop(element, scrollTop) : false
    },
    [applyRestoredScrollTop, readScrollTop]
  )

  const restorePendingScrollTop = useCallback(
    (element: T): boolean => {
      const scrollTop = pendingRestoreScrollTopRef.current
      return isPresent(scrollTop) ? applyRestoredScrollTop(element, scrollTop) : false
    },
    [applyRestoredScrollTop]
  )

  const scrollToBottom = useCallback(
    (element: T): void => {
      element.scrollTo({ top: element.scrollHeight, behavior: 'auto' })
      lastScrollTopRef.current = element.scrollTop
      persistScrollTop(element.scrollTop)
    },
    [persistScrollTop]
  )

  const scrollToBottomIfPinned = useCallback((): void => {
    const element = ref.current
    if (!element) return

    if (followLockedRef.current) {
      pendingRestoreScrollTopRef.current = null
      shouldStickToBottomRef.current = true
      scrollToBottom(element)
      return
    }

    if (restorePendingScrollTop(element)) return

    const currentScrollTop = element.scrollTop
    const shouldAutoScroll = shouldAutoScrollAfterContentResize({
      pinned: shouldStickToBottomRef.current,
      previousScrollTop: lastScrollTopRef.current,
      currentScrollTop,
      isNearBottom: isNearBottom(element),
      movementTolerancePx: ContentGrowthUpwardTolerancePx,
    })

    if (!shouldAutoScroll) {
      shouldStickToBottomRef.current = false
      lastScrollTopRef.current = currentScrollTop
      persistScrollTop(currentScrollTop)
      return
    }

    scrollToBottom(element)
  }, [isNearBottom, persistScrollTop, restorePendingScrollTop, scrollToBottom])

  const cancelPendingScroll = useCallback((): void => {
    if (!isPresent(scrollFrameRef.current)) return
    scrollFrameRef.current.cancel()
    scrollFrameRef.current = null
  }, [])

  const suspendAutoScroll = useCallback((): void => {
    if (followLockedRef.current) return
    const element = ref.current
    if (!element) return

    cancelPendingScroll()
    shouldStickToBottomRef.current = false
    lastScrollTopRef.current = element.scrollTop
    persistScrollTop(element.scrollTop)
  }, [cancelPendingScroll, persistScrollTop])

  const handleWheel = useCallback((event: WheelEvent): void => {
    const decision = resolveAutoScrollWheelDecision(followLockedRef.current, event.deltaY)

    if (decision.shouldPreventDefault) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }

    if (!decision.shouldSuspendAutoScroll) return
    ref.current?.dispatchEvent(new Event(AutoScrollSuspendEventName, { bubbles: true }))
  }, [])

  const handlePointerDown = useCallback((event: PointerEvent): void => {
    if (followLockedRef.current) return
    // 触摸/笔势在 scroll 之前到达；鼠标仅在直接抓取滚动面（含滚动条）时视为滚动意图。
    if (event.pointerType === 'mouse' && event.target !== ref.current) return
    ref.current?.dispatchEvent(new Event(AutoScrollSuspendEventName, { bubbles: true }))
  }, [])

  const updatePinnedState = useCallback((): void => {
    const element = ref.current
    if (!element) return

    if (followLockedRef.current) {
      pendingRestoreScrollTopRef.current = null
      shouldStickToBottomRef.current = true
      lastScrollTopRef.current = element.scrollTop
      persistScrollTop(element.scrollTop)
      return
    }

    if (isPresent(pendingRestoreScrollTopRef.current)) {
      shouldStickToBottomRef.current = false
      lastScrollTopRef.current = element.scrollTop
      return
    }

    const currentScrollTop = element.scrollTop
    shouldStickToBottomRef.current = resolveAutoScrollPinnedAfterScroll({
      previousPinned: shouldStickToBottomRef.current,
      previousScrollTop: lastScrollTopRef.current,
      currentScrollTop,
      isNearBottom: isNearBottom(element),
      isAtBottom: isAtBottom(element),
      upwardScrollTolerancePx: UpwardScrollTolerancePx,
    })
    lastScrollTopRef.current = currentScrollTop
    persistScrollTop(currentScrollTop)
  }, [isAtBottom, isNearBottom, persistScrollTop])

  useEventListener('scroll', updatePinnedState, { target: ref, passive: true })
  useEventListener('wheel', handleWheel, {
    target: ref,
    capture: true,
    passive: false,
  })
  useEventListener('pointerdown', handlePointerDown, { target: ref, capture: true })
  useEventListener(AutoScrollSuspendEventName, suspendAutoScroll, { target: ref })

  const setFollowLocked = useCallback(
    (locked: boolean): void => {
      followLockedRef.current = locked
      setFollowLockedState(locked)

      const element = ref.current
      if (!locked || !element) return

      pendingRestoreScrollTopRef.current = null
      shouldStickToBottomRef.current = true
      cancelPendingScroll()
      scrollToBottom(element)
    },
    [cancelPendingScroll, scrollToBottom]
  )

  useEffect(() => {
    const element = ref.current
    if (!element) return
    shouldStickToBottomRef.current = true
    lastScrollTopRef.current = element.scrollTop
  }, [])

  useLayoutEffect(() => {
    const element = ref.current
    const resetKeyChanged = !Object.is(lastResetKeyRef.current, resetKey)
    const restoreKeyChanged = !Object.is(lastRestoreKeyRef.current, restoreKey)
    lastResetKeyRef.current = resetKey
    lastRestoreKeyRef.current = restoreKey
    shouldStickToBottomRef.current = resolveAutoScrollPinnedAfterReset({
      currentPinned: shouldStickToBottomRef.current,
      resetKeyChanged,
    })

    if (!element) return

    if (followLockedRef.current) {
      pendingRestoreScrollTopRef.current = null
      shouldStickToBottomRef.current = true
      cancelPendingScroll()
      scrollToBottom(element)
      return
    }

    if (restoreKeyChanged && restoreScrollTop(element)) return
    if (restorePendingScrollTop(element)) return
    if (!shouldStickToBottomRef.current) return

    const currentScrollTop = element.scrollTop
    const shouldAutoScroll = shouldStartImmediateAutoScroll({
      pinned: shouldStickToBottomRef.current,
      previousScrollTop: lastScrollTopRef.current,
      currentScrollTop,
      isNearBottom: isNearBottom(element),
      movementTolerancePx: ContentGrowthUpwardTolerancePx,
    })

    if (!shouldAutoScroll) {
      shouldStickToBottomRef.current = false
      lastScrollTopRef.current = currentScrollTop
      persistScrollTop(currentScrollTop)
      return
    }

    cancelPendingScroll()
    scrollToBottom(element)
    const scheduledScrollTop = element.scrollTop
    scrollFrameRef.current = scrollTimers.nextFrame(() => {
      scrollFrameRef.current = null
      const latestElement = ref.current
      if (!latestElement) return

      if (shouldCommitScheduledAutoScroll({
        pinned: shouldStickToBottomRef.current,
        scheduledScrollTop,
        currentScrollTop: latestElement.scrollTop,
        isNearBottom: isNearBottom(latestElement),
        movementTolerancePx: ContentGrowthUpwardTolerancePx,
      })) {
        scrollToBottom(latestElement)
        return
      }

      shouldStickToBottomRef.current = false
      lastScrollTopRef.current = latestElement.scrollTop
      persistScrollTop(latestElement.scrollTop)
    })

    return cancelPendingScroll
  }, [
    cancelPendingScroll,
    followLocked,
    isNearBottom,
    persistScrollTop,
    resetKey,
    restoreKey,
    restorePendingScrollTop,
    restoreScrollTop,
    scrollTimers,
    scrollToBottom,
    trigger,
  ])

  useEffect(() => {
    const element = ref.current
    const ResizeObserverConstructor = globalThis.ResizeObserver
    if (!element || !ResizeObserverConstructor) return

    const observer = new ResizeObserverConstructor(scrollToBottomIfPinned)
    observer.observe(element)
    const contentElement = element.firstElementChild
    if (contentElement) observer.observe(contentElement)

    return () => observer.disconnect()
  }, [resetKey, scrollToBottomIfPinned, trigger])

  return { followLocked, scrollRef: ref, setFollowLocked }
}
