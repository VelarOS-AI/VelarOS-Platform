import { useEffect, useRef } from 'react'

import {
  createTimerScopeLifecycleState,
  markTimerScopeCommitted,
  prepareTimerScopeRender,
  type TimerScopeLifecycleState,
} from './timerScopeLifecycle'

import type { TimerScope } from '#internal/timerScope'

/**
 * 组件生命周期作用域的 TimerScope（挂载期创建、卸载期微任务处置）。零耦合叶子 hook，随卡入包；
 * 宿主 `@hooks/ui/useTimerScope` 另有同源副本。
 */
export function useTimerScope(name?: string): TimerScope {
  const lifecycleRef = useRef<LooseOptional<TimerScopeLifecycleState>>(null)
  if (!lifecycleRef.current) {
    lifecycleRef.current = createTimerScopeLifecycleState()
  }

  const lifecycle = lifecycleRef.current
  const timers = prepareTimerScopeRender(lifecycle, name)

  useEffect(() => markTimerScopeCommitted(lifecycle, timers), [lifecycle, timers])

  return timers
}
