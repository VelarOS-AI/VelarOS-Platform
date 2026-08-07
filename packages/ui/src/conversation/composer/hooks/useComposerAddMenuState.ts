import { useEffect, useState } from 'react'
import { useMemoizedFn } from 'ahooks'

import type { ComposerSubmenuId } from '../chatInputTypes'
import { OnboardingCloseComposerMenusEventName } from '../composerHostEvents'

type ComposerMenuTourLock = 'primary' | 'plugins'

function getComposerMenuTourLock(): Nullable<ComposerMenuTourLock> {
  const lock = document.documentElement.dataset.tourComposerMenuLock
  return lock === 'primary' || lock === 'plugins' ? lock : null
}

export interface UseComposerAddMenuStateResult {
  composerMenuOpen: boolean
  composerSubmenuId: Nullable<ComposerSubmenuId>
  setComposerMenuOpenState: (open: boolean) => void
  closeComposerSubmenus: () => void
  handleComposerActiveSubmenuChange: (submenuId: Nullable<string>) => void
}

export function useComposerAddMenuState(): UseComposerAddMenuStateResult {
  const [composerMenuOpen, setComposerMenuOpen] = useState(false)
  const [composerSubmenuId, setComposerSubmenuId] = useState<Nullable<ComposerSubmenuId>>(null)

  const closeComposerSubmenus = useMemoizedFn((): void => {
    const tourLock = getComposerMenuTourLock()
    if (tourLock === 'plugins') {
      setComposerSubmenuId(tourLock)
      return
    }
    setComposerSubmenuId(null)
  })

  const setComposerMenuOpenState = useMemoizedFn((open: boolean): void => {
    if (!open && getComposerMenuTourLock()) return
    if (!open) {
      closeComposerSubmenus()
    }
    setComposerMenuOpen(open)
  })

  const handleComposerActiveSubmenuChange = useMemoizedFn((submenuId: Nullable<string>): void => {
    const tourLock = getComposerMenuTourLock()
    if (tourLock === 'plugins') {
      setComposerSubmenuId(tourLock)
      return
    }
    const nextSubmenuId: Nullable<ComposerSubmenuId> =
      submenuId === 'quick-prompts' ||
      submenuId === 'plugins' ||
      submenuId === 'skills'
        ? submenuId
        : null

    setComposerSubmenuId(nextSubmenuId)
  })

  useEffect(() => {
    const forceCloseComposerMenus = (): void => {
      setComposerSubmenuId(null)
      setComposerMenuOpen(false)
    }
    window.addEventListener(OnboardingCloseComposerMenusEventName, forceCloseComposerMenus)
    return () =>
      window.removeEventListener(OnboardingCloseComposerMenusEventName, forceCloseComposerMenus)
  }, [])

  return {
    composerMenuOpen,
    composerSubmenuId,
    setComposerMenuOpenState,
    closeComposerSubmenus,
    handleComposerActiveSubmenuChange,
  }
}
