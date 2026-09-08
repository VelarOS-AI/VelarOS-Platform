import { useSyncExternalStore } from 'react'

export interface ChatScrollNavigatorVisibilityStore {
  getSnapshot: () => boolean
  setHidden: (hidden: boolean) => void
  subscribe: (listener: () => void) => () => void
  toggle: () => void
}

/**
 * 为带自有 header 的侧栏聊天创建显隐位。状态由宿主实例持有，但订阅与幂等通知语义统一归 UI。
 * 模块级创建即可像 Desktop 一样跨 pane 重挂载保留，且不会把具体产品或存储方案带进组件库。
 */
export function createChatScrollNavigatorVisibilityStore(
  initiallyHidden = false
): ChatScrollNavigatorVisibilityStore {
  let hidden = initiallyHidden
  const listeners = new Set<() => void>()

  const setHidden = (nextHidden: boolean): void => {
    if (hidden === nextHidden) return
    hidden = nextHidden
    for (const listener of listeners) listener()
  }

  return {
    getSnapshot: () => hidden,
    setHidden,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    toggle: () => setHidden(!hidden),
  }
}

export function useChatScrollNavigatorHidden(
  store: ChatScrollNavigatorVisibilityStore
): boolean {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => false)
}
