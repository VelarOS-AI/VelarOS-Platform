/**
 * 折叠/弹层显示用的「挂载 + 可见」两阶段状态，配合 CSS transition：关闭时先 visible=false，再在 duration 后 unmount。
 */
import { useEffect, useRef, useState } from 'react'
import { useUnmount } from 'ahooks'

import { type TimerLease, TimerScope } from './timerScope'

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
  const timersRef = useRef<LooseOptional<TimerScope>>(null)
  if (!timersRef.current) {
    timersRef.current = new TimerScope({ name: 'useDisclosurePresence' })
  }

  useUnmount(() => {
    timersRef.current?.dispose()
  })

  useEffect(() => {
    let timers = timersRef.current
    // React StrictMode 会在开发环境中执行一次 effect 的 setup → cleanup → setup。
    // 第二次 setup 前不会重新渲染，因此 ref 仍可能指向第一次 cleanup 已释放的作用域。
    if (!timers || timers.isDisposed) {
      timers = new TimerScope({ name: 'useDisclosurePresence' })
      timersRef.current = timers
    }

    closeTimerRef.current?.cancel()
    closeTimerRef.current = null
    frameRef.current?.cancel()
    frameRef.current = null

    if (open) {
      setMounted(true)
      // 双重 rAF：保证先提交 DOM 再将 visible 置 true，从而稳定触发入场过渡。
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
  }, [durationMs, open])

  return {
    mounted,
    visible,
  }
}
