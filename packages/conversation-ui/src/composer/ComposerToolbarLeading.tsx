import React, { memo } from 'react'
import { PlusIcon } from '@phosphor-icons/react'
import type { ChangeEvent, ReactElement, ReactNode, RefObject } from 'react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

import { ComposerAddMenu, type ComposerAddMenuProps } from './ComposerAddMenu'

import styles from './ChatInput.module.css'

export interface ComposerToolbarLeadingProps {
  density?: 'default' | 'compact'
  disabled: boolean
  fileInputRef: RefObject<Nullable<HTMLInputElement>>
  onHiddenFileInputChange: (event: ChangeEvent<HTMLInputElement>) => void
  showHiddenFileInput: boolean
  canShowComposerMenu: boolean
  addMenuProps: Nullable<ComposerAddMenuProps>
  attachFileLabel: string
  onFallbackAttachClick: () => void
  activeChips?: ReactNode
  leftActions?: ReactNode
  bottomSlot?: ReactNode
}

function ComposerToolbarLeadingInner({
  density = 'default',
  disabled,
  fileInputRef,
  onHiddenFileInputChange,
  showHiddenFileInput,
  canShowComposerMenu,
  addMenuProps,
  attachFileLabel,
  onFallbackAttachClick,
  activeChips,
  leftActions,
  bottomSlot,
}: ComposerToolbarLeadingProps): ReactElement {
  const showFallbackAttach = !canShowComposerMenu && showHiddenFileInput

  return (
    <Inline className={styles.toolbarLeft} gap="sm">
      {showHiddenFileInput && (
        <Input
          ref={fileInputRef}
          type="file"
          multiple
          variant="ghost"
          size="sm"
          onChange={onHiddenFileInputChange}
          className={styles.fileInputHidden}
          disabled={disabled}
        />
      )}
      {canShowComposerMenu && addMenuProps ? (
        <ComposerAddMenu {...addMenuProps} density={density} />
      ) : showFallbackAttach && (
        <IconButton
          label={attachFileLabel}
          size="icon"
          onClick={onFallbackAttachClick}
          disabled={disabled}
          className={styles.attachButton}
        >
          <PlusIcon size={16} weight="bold" />
        </IconButton>
      )}
      {leftActions}
      {bottomSlot}
      {activeChips}
    </Inline>
  )
}

export const ComposerToolbarLeading = memo(ComposerToolbarLeadingInner)
ComposerToolbarLeading.displayName = 'ComposerToolbarLeading'
