import { useCallback, useEffect, useRef, useState } from 'react'
import { useLatest, useUnmount } from 'ahooks'

import { useTimerScope } from '../react-hooks/useTimerScope'

import { isEmpty, isPresent, last, optionalWhen } from '#internal/runtime'
import type { TimerLease } from '#internal/timerScope'

const LiveStatusMinVisibleMs = 900

function normalizeLiveStatusText(value: Optional<string>): Optional<string> {
  const normalized = value?.trim()
  return optionalWhen(normalized && !isEmpty(normalized), normalized)
}

/** 对话 live status 文案队列：最短可见时长内不闪烁切换。 */
export function useQueuedLiveStatusText(
  value: Optional<string>,
  enabled: boolean,
  resetKey: string
): string | undefined {
  const nextValue = normalizeLiveStatusText(value)
  const [displayValue, setDisplayValue] = useState(nextValue)
  const displayValueRef = useRef(nextValue)
  const lastChangeAtRef = useRef(Date.now())
  const queueRef = useRef<Array<string | undefined>>([])
  const timers = useTimerScope('useQueuedLiveStatusText')
  const timerRef = useRef<TimerLease>(null)
  const enabledLatest = useLatest(enabled)

  const clearTimer = useCallback((): void => {
    if (!isPresent(timerRef.current)) return

    timerRef.current.cancel()
    timerRef.current = null
  }, [])

  const flushQueue = useCallback((): void => {
    clearTimer()

    if (!enabledLatest.current || isEmpty(queueRef.current)) return

    const elapsed = Date.now() - lastChangeAtRef.current
    const delay = !isPresent(displayValueRef.current)
      ? 0
      : Math.max(0, LiveStatusMinVisibleMs - elapsed)
    if (delay > 0) {
      timerRef.current = timers.after(delay, flushQueue, { label: 'chat.liveStatus.flush' })
      return
    }

    let queuedValue = queueRef.current.shift()
    while (!isEmpty(queueRef.current) && Object.is(queuedValue, displayValueRef.current)) {
      queuedValue = queueRef.current.shift()
    }

    if (!Object.is(queuedValue, displayValueRef.current)) {
      displayValueRef.current = queuedValue
      lastChangeAtRef.current = Date.now()
      setDisplayValue(queuedValue)
    }

    if (!isEmpty(queueRef.current)) {
      timerRef.current = timers.after(LiveStatusMinVisibleMs, flushQueue, {
        label: 'chat.liveStatus.minVisible',
      })
    }
  }, [clearTimer, timers])

  useEffect(() => {
    clearTimer()
    queueRef.current = []
    displayValueRef.current = nextValue
    lastChangeAtRef.current = Date.now()
    setDisplayValue(nextValue)
  }, [clearTimer, resetKey])

  useEffect(() => {
    if (enabled) {
      flushQueue()
      return
    }

    clearTimer()
    queueRef.current = []
    displayValueRef.current = nextValue
    lastChangeAtRef.current = Date.now()
    setDisplayValue(nextValue)
  }, [clearTimer, enabled, flushQueue, nextValue])

  useEffect(() => {
    if (!enabled) return

    if (Object.is(nextValue, displayValueRef.current) && isEmpty(queueRef.current)) return

    const hasQueuedValue = !isEmpty(queueRef.current)
    const lastQueuedValue = optionalWhen(hasQueuedValue, last(queueRef.current))

    if (!hasQueuedValue || !Object.is(nextValue, lastQueuedValue)) {
      queueRef.current.push(nextValue)
    }

    flushQueue()
  }, [enabled, flushQueue, nextValue])

  useUnmount(clearTimer)

  return displayValue
}
