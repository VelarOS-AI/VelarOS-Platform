import { TimerScope } from '#internal/timerScope'

/**
 * TimerScope 的 render/commit/dispose 生命周期编排（零耦合，只依赖包内 UI TimerScope）。
 * 随 `useTimerScope` 副本入包；宿主 `@hooks/ui/timerScopeLifecycle` 另有同源副本（随参考壳退场）。
 */
type TimerScopeDisposalScheduler = (disposal: () => void) => void

interface TimerScopeLifecycleState {
  committedEffectVersion: number
  scope: LooseOptional<TimerScope>
}

function scheduleTimerScopeDisposal(disposal: () => void): void {
  queueMicrotask(disposal)
}

function createTimerScopeLifecycleState(): TimerScopeLifecycleState {
  return {
    committedEffectVersion: 0,
    scope: null,
  }
}

function prepareTimerScopeRender(state: TimerScopeLifecycleState, name?: string): TimerScope {
  if (!state.scope || state.scope.isDisposed) {
    state.scope = new TimerScope({ name })
  }

  return state.scope
}

function markTimerScopeCommitted(
  state: TimerScopeLifecycleState,
  scope: TimerScope,
  scheduleDisposal: TimerScopeDisposalScheduler = scheduleTimerScopeDisposal
): () => void {
  state.committedEffectVersion += 1
  const committedEffectVersion = state.committedEffectVersion

  return () => {
    scheduleDisposal(() => {
      if (state.committedEffectVersion !== committedEffectVersion) return
      if (state.scope !== scope) return

      scope.dispose()
      state.scope = null
    })
  }
}

export { createTimerScopeLifecycleState, markTimerScopeCommitted, prepareTimerScopeRender }
export type { TimerScopeLifecycleState }
