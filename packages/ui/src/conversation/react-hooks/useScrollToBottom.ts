import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useEventListener } from 'ahooks'

import {
  type ConversationScrollFollow,
  registerConversationScrollFollow,
} from './conversationScrollFollow'
import {
  AutoScrollSuspendEventName,
  resolveAutoScrollPinnedAfterReset,
  resolveAutoScrollPinnedAfterScroll,
  resolveAutoScrollWheelDecision,
  resolveRestoredScrollTop,
  resolveScrollClampGuard,
  type ScrollClampGuardCause,
  ScrollClampGuardCssVariable,
  shouldAutoScrollAfterContentResize,
  shouldCommitScheduledAutoScroll,
  shouldStartImmediateAutoScroll,
} from './scrollBehavior'
import { useTimerScope } from './useTimerScope'

import { isFiniteNumber, isPresent } from '#internal/runtime'
import type { TimerLease } from '#internal/timerScope'

const AutoScrollThresholdPx = 24
const AtBottomThresholdPx = 2
const UpwardScrollTolerancePx = 1
const ContentGrowthUpwardTolerancePx = 48
const ClampGuardRestoreTolerancePx = 1
const UnsetRestoreKey = Symbol('unset-scroll-restore-key')

/**
 * 夹底守卫的占位高度以滚动容器上的内联 CSS 变量为唯一事实：容器重挂载后自然归零，
 * 不会串到新容器。
 */
function readScrollClampGuardPx(element: HTMLElement): number {
  const guardPx = Number.parseFloat(element.style.getPropertyValue(ScrollClampGuardCssVariable))
  return isFiniteNumber(guardPx) ? guardPx : 0
}

function writeScrollClampGuardPx(element: HTMLElement, guardPx: number): void {
  if (readScrollClampGuardPx(element) === guardPx) return

  if (guardPx > 0) element.style.setProperty(ScrollClampGuardCssVariable, `${guardPx}px`)
  else element.style.removeProperty(ScrollClampGuardCssVariable)
}

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
 *
 * 读者解除跟随后，界面自己的变化不能挪动他正在看的内容：
 * - 跟随状态按 scrollRef 登记（见 `conversationScrollFollow`），会话面板据此让自动收起只在跟随时发生；
 * - 视口里的内容变矮、浏览器要把 scrollTop 夹到新底部时，在绘制前用滚动内容末尾的占位（高度写在
 *   容器的 `ScrollClampGuardCssVariable` 上）把位置撑住并放回原位；恢复跟随时占位清零。
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

  const scrollFollow = useMemo<ConversationScrollFollow>(
    () => ({
      isFollowingBottom: () => followLockedRef.current || shouldStickToBottomRef.current,
    }),
    []
  )

  useLayoutEffect(() => registerConversationScrollFollow(ref, scrollFollow), [scrollFollow])

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

  // 占位撑住的那段不是真实内容：记下的位置不越过自然底部，切回会话时不会卡进待恢复状态。
  const persistScrollTop = useCallback(
    (element: T, scrollTop: number): void => {
      const guardPx = readScrollClampGuardPx(element)
      const readerScrollTop =
        guardPx > 0
          ? Math.min(scrollTop, element.scrollHeight - element.clientHeight - guardPx)
          : scrollTop
      writeScrollTop?.(Math.max(0, Math.floor(readerScrollTop)))
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
      persistScrollTop(element, element.scrollTop)
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

  // 回到底部即恢复跟随：先撤掉占位，底部才是真实内容的底部。
  const scrollToBottom = useCallback(
    (element: T): void => {
      writeScrollClampGuardPx(element, 0)
      element.scrollTo({ top: element.scrollHeight, behavior: 'auto' })
      lastScrollTopRef.current = element.scrollTop
      persistScrollTop(element, element.scrollTop)
    },
    [persistScrollTop]
  )

  // 夹底守卫接线：占位写到容器上，被夹走的位置在同一次回调里放回；宿主没挂占位元素时撑不住，
  // 撤回守卫交给浏览器的夹底。
  const settleScrollClampGuard = useCallback(
    (element: T, cause: ScrollClampGuardCause): void => {
      const decision = resolveScrollClampGuard({
        following: scrollFollow.isFollowingBottom(),
        cause,
        guardPx: readScrollClampGuardPx(element),
        previousScrollTop: lastScrollTopRef.current,
        currentScrollTop: element.scrollTop,
        maxScrollTop: element.scrollHeight - element.clientHeight,
        viewportHeight: element.clientHeight,
      })
      writeScrollClampGuardPx(element, decision.guardPx)
      if (!isPresent(decision.restoreScrollTop)) return

      element.scrollTo({ top: decision.restoreScrollTop, behavior: 'auto' })
      if (element.scrollTop < decision.restoreScrollTop - ClampGuardRestoreTolerancePx)
        writeScrollClampGuardPx(element, 0)
    },
    [scrollFollow]
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

    const shouldAutoScroll = shouldAutoScrollAfterContentResize({
      pinned: shouldStickToBottomRef.current,
      previousScrollTop: lastScrollTopRef.current,
      currentScrollTop: element.scrollTop,
      isNearBottom: isNearBottom(element),
      movementTolerancePx: ContentGrowthUpwardTolerancePx,
    })

    if (!shouldAutoScroll) {
      shouldStickToBottomRef.current = false
      // ResizeObserver 回调在绘制前执行：夹底在这里放回，读者看不到那一帧跳动。
      settleScrollClampGuard(element, 'content-resize')
      lastScrollTopRef.current = element.scrollTop
      persistScrollTop(element, element.scrollTop)
      return
    }

    scrollToBottom(element)
  }, [
    isNearBottom,
    persistScrollTop,
    restorePendingScrollTop,
    scrollToBottom,
    settleScrollClampGuard,
  ])

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
    persistScrollTop(element, element.scrollTop)
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
      persistScrollTop(element, element.scrollTop)
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
    persistScrollTop(element, currentScrollTop)
    // 读者上滑时占位随之缩小；滚完余量回到底部即恢复跟随，占位清零。
    settleScrollClampGuard(element, 'reader-scroll')
  }, [isAtBottom, isNearBottom, persistScrollTop, settleScrollClampGuard])

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
    // 换会话或发出新消息：上一段内容撑出来的占位作废，恢复位置与贴底都按真实内容算。
    if (resetKeyChanged || restoreKeyChanged) writeScrollClampGuardPx(element, 0)

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
      persistScrollTop(element, currentScrollTop)
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
      persistScrollTop(latestElement, latestElement.scrollTop)
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
