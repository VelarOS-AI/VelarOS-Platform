import React from 'react'
import { ImageIcon, XIcon } from '@phosphor-icons/react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import { useObjectUrl } from '../react-hooks/useObjectUrl'

import styles from './ChatInput.module.css'

// ─── ChatInputImageThumb ──────────────────────────────────────────────────────

function ChatInputImageThumb({
  file,
  previewLabel,
  onPreview,
  onRemove,
  disabled,
  removeLabel,
}: {
  file: File
  previewLabel: string
  onPreview: () => void
  onRemove: () => void
  disabled?: boolean
  removeLabel: string
}): React.ReactElement {
  const previewUrl = useObjectUrl(file)

  if (!previewUrl)
    return (
      <div className={styles.imageThumbPlaceholder}>
        <ImageIcon size={16} className={styles.fileChipName} />
        <IconButton
          label={removeLabel}
          size={14}
          shape="round"
          onClick={onRemove}
          disabled={disabled}
          className={styles.fileRemoveBtn}
        >
          <XIcon size={8} />
        </IconButton>
      </div>
    )

  return (
    <div className={styles.imageThumb}>
      <Button
        variant="ghost"
        size="block"
        hoverBackground={false}
        className={styles.imageThumbButton}
        onClick={onPreview}
        aria-label={previewLabel}
      >
        <img src={previewUrl} alt="" className={styles.imageThumbImg} />
      </Button>
      <IconButton
        label={removeLabel}
        size={14}
        shape="round"
        onClick={onRemove}
        disabled={disabled}
        className={styles.fileRemoveBtn}
      >
        <XIcon size={8} />
      </IconButton>
    </div>
  )
}

export { ChatInputImageThumb }
