import { useSyncExternalStore } from 'react'

const darkModeListeners = new Set<() => void>()
let darkModeObserver: Nullable<MutationObserver> = null

function subscribeDarkMode(onStoreChange: () => void): () => void {
  darkModeListeners.add(onStoreChange)
  if (!darkModeObserver) {
    darkModeObserver = new MutationObserver(() => {
      for (const listener of darkModeListeners) {
        listener()
      }
    })
    darkModeObserver.observe(document.documentElement, {
      attributeFilter: ['class', 'data-theme'],
    })
  }

  return () => {
    darkModeListeners.delete(onStoreChange)
    if (darkModeListeners.size > 0) return
    darkModeObserver?.disconnect()
    darkModeObserver = null
  }
}

export function getIsDarkMode(): boolean {
  return (
    document.documentElement.classList.contains('dark') ||
    document.documentElement.dataset.theme === 'dark'
  )
}

export function useIsDarkMode(): boolean {
  return useSyncExternalStore(subscribeDarkMode, getIsDarkMode, () => false)
}
