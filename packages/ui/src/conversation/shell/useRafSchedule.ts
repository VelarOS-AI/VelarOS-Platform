import { useEffect, useRef } from 'react'
import { useLatest, useMemoizedFn } from 'ahooks'

import { type TimerLease, TimerScope } from '#internal/timerScope'

/** 把快速连续调用合并到下一帧执行，并在卸载时取消待执行任务。 */
export function useRafSchedule(callback: () => void): () => void {
  const frameRef = useRef<LooseOptional<TimerLease>>(null)
  const mountedRef = useRef(false)
  const timersRef = useRef<LooseOptional<TimerScope>>(null)
  const cb = useLatest(callback)

  const getTimers = (): TimerScope => {
    if (!timersRef.current || timersRef.current.isDisposed) {
      timersRef.current = new TimerScope({ name: 'useRafSchedule' })
    }

    return timersRef.current
  }

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      frameRef.current?.cancel()
      frameRef.current = null
      timersRef.current?.dispose()
      timersRef.current = null
    }
  }, [])

  return useMemoizedFn((): void => {
    if (!mountedRef.current) return

    frameRef.current?.cancel()
    frameRef.current = getTimers().nextFrame(() => {
      frameRef.current = null
      if (!mountedRef.current) return

      cb.current()
    })
  })
}
