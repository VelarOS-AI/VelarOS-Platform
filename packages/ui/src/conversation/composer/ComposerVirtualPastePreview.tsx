import { memo, type ReactElement } from 'react'
import { CaretRightIcon, ClipboardTextIcon, XIcon } from '@phosphor-icons/react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import type { ChatVirtualPasteReference } from './utils/chatVirtualPasteReferences'

import styles from './ChatInput.module.css'

import { isEmpty } from '#internal/runtime'

export interface ComposerVirtualPastePreviewProps {
  references: readonly ChatVirtualPasteReference[]
  disabled: boolean
  showInInputLabel: string
  removeLabel: string
  formatMeta: (reference: ChatVirtualPasteReference) => string
  onInsertMarker: (reference: ChatVirtualPasteReference) => void
  onRemove: (id: string) => void
}

function ComposerVirtualPastePreviewInner({
  references,
  disabled,
  showInInputLabel,
  removeLabel,
  formatMeta,
  onInsertMarker,
  onRemove,
}: ComposerVirtualPastePreviewProps): Nullable<ReactElement> {
  if (isEmpty(references)) return null

  return (
    <div className={styles.virtualPasteList}>
      {references.map((reference) => (
        <div key={reference.id} className={styles.virtualPasteCard}>
          <div className={styles.virtualPasteIconBox}>
            <ClipboardTextIcon size={18} weight="regular" />
          </div>
          <div className={styles.virtualPasteBody}>
            <div className={styles.virtualPasteTitle} title={reference.title}>
              {reference.title}
            </div>
            <div className={styles.virtualPasteMeta}>{formatMeta(reference)}</div>
            <button
              type="button"
              className={styles.virtualPasteShowButton}
              disabled={disabled}
              onClick={() => onInsertMarker(reference)}
            >
              <span>{showInInputLabel}</span>
              <CaretRightIcon size={12} />
            </button>
          </div>
          <IconButton
            label={removeLabel}
            title={removeLabel}
            size={18}
            className={styles.virtualPasteRemoveButton}
            disabled={disabled}
            onClick={() => onRemove(reference.id)}
          >
            <XIcon size={9} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}

export const ComposerVirtualPastePreview = memo(ComposerVirtualPastePreviewInner)
ComposerVirtualPastePreview.displayName = 'ComposerVirtualPastePreview'
