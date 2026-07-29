import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLatest } from 'ahooks'

import { useTimerScope } from '../react-hooks/useTimerScope'

import { shouldObserveOlderMessageSentinel } from './chatConversationScroll'

interface UseChatConversationScrollOptions {
  sessionId: string
  conversationRefreshKey?: string | number
  hasOlderMessages?: boolean
  isLoadingOlderMessages?: boolean
  onLoadOlderMessages?: () => void
  enableOlderMessageSentinel?: boolean
}

export interface UseChatConversationScrollReturn {
  loadMoreSentinelRef: RefObject<Nullable<HTMLDivElement>>
  initialBottomScrollSettled: boolean
  canTriggerOlderLoad: boolean
}

/** 对话区向上翻页哨兵与首屏贴底滚动 settle 状态。 */
export function useChatConversationScroll({
  sessionId,
  conversationRefreshKey,
  hasOlderMessages = false,
  isLoadingOlderMessages = false,
  onLoadOlderMessages,
  enableOlderMessageSentinel = true,
}: UseChatConversationScrollOptions): UseChatConversationScrollReturn {
  const initialBottomScrollTimers = useTimerScope('useChatConversationScroll.initialBottomScroll')
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const initialBottomScrollKey = `${sessionId}:${conversationRefreshKey ?? ''}`
  const [initialBottomScrollState, setInitialBottomScrollState] = useState({
    key: initialBottomScrollKey,
    settled: false,
  })
  const initialBottomScrollSettled =
    initialBottomScrollState.key === initialBottomScrollKey && initialBottomScrollState.settled
  const isLoadingOlderLatest = useLatest(isLoadingOlderMessages)
  const onLoadOlderLatest = useLatest(onLoadOlderMessages)
  const canTriggerOlderLoad = shouldObserveOlderMessageSentinel({
    hasOlderMessages,
    hasLoadHandler: !!onLoadOlderMessages,
    initialBottomScrollSettled,
  })

  useLayoutEffect(() => {
    setInitialBottomScrollState({ key: initialBottomScrollKey, settled: false })

    const frame = initialBottomScrollTimers.nextFrame(() => {
      setInitialBottomScrollState({ key: initialBottomScrollKey, settled: true })
    })

    return () => {
      frame.cancel()
    }
  }, [initialBottomScrollKey, initialBottomScrollTimers])

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current
    if (!enableOlderMessageSentinel || !sentinel || !canTriggerOlderLoad) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isLoadingOlderLatest.current) {
          onLoadOlderLatest.current?.()
        }
      },
      {
        // 用滚动容器作为 root，这里用 null （viewport）即可因为 ScrollArea 自己是 overflow
        threshold: 0,
        rootMargin: '200px 0px 0px 0px', // 满屏前 200px 即触发
      }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [canTriggerOlderLoad, enableOlderMessageSentinel, isLoadingOlderLatest, onLoadOlderLatest])

  return {
    loadMoreSentinelRef,
    initialBottomScrollSettled,
    canTriggerOlderLoad,
  }
}
