import { useEffect, useRef, useState } from 'react'
import { useUnmount } from 'ahooks'

import { useTimerScope } from './useTimerScope'

import type { TimerLease } from '#internal/timerScope'

/**
 * 折叠/展开的挂载-可见两态过渡（进场双帧、出场延时卸载）。零耦合叶子 hook，随会话渲染件入包；
 * 宿主 `@hooks/ui/useDisclosurePresence` 另有同源副本（随参考壳退场）。
 */
export const DEFAULT_DISCLOSURE_PRESENCE_DURATION_MS = 220

export interface DisclosurePresenceState {
  mounted: boolean
  visible: boolean
}

interface DisclosurePresenceOptions {
  durationMs?: number
}

export function useDisclosurePresence(
  open: boolean,
  options: DisclosurePresenceOptions = {}
): DisclosurePresenceState {
  const durationMs = options.durationMs ?? DEFAULT_DISCLOSURE_PRESENCE_DURATION_MS
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(open)
  const closeTimerRef = useRef<LooseOptional<TimerLease>>(null)
  const frameRef = useRef<LooseOptional<TimerLease>>(null)
  const timers = useTimerScope('useDisclosurePresence')

  useUnmount(() => {
    closeTimerRef.current?.cancel()
    frameRef.current?.cancel()
  })

  useEffect(() => {
    closeTimerRef.current?.cancel()
    closeTimerRef.current = null
    frameRef.current?.cancel()
    frameRef.current = null

    if (open) {
      setMounted(true)
      frameRef.current = timers.nextFrame(() => {
        frameRef.current = timers.nextFrame(() => {
          setVisible(true)
          frameRef.current = null
        })
      })
      return
    }

    setVisible(false)
    closeTimerRef.current = timers.after(durationMs, () => {
      setMounted(false)
      closeTimerRef.current = null
    })
  }, [durationMs, open, timers])

  return {
    mounted,
    visible,
  }
}
