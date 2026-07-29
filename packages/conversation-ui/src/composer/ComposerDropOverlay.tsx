import { memo, type ReactElement } from 'react'

import styles from './ChatInput.module.css'

export interface ComposerDropOverlayProps {
  active: boolean
  title: string
  hint: string
}

function ComposerDropOverlayInner({
  active,
  title,
  hint,
}: ComposerDropOverlayProps): Nullable<ReactElement> {
  if (!active) return null

  return (
    <div className={styles.dropOverlay} aria-hidden="true">
      <div className={styles.dropOverlayTitle}>{title}</div>
      <div className={styles.dropOverlayHint}>{hint}</div>
    </div>
  )
}

export const ComposerDropOverlay = memo(ComposerDropOverlayInner)
ComposerDropOverlay.displayName = 'ComposerDropOverlay'
