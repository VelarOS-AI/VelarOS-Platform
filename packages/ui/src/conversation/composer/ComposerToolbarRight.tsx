import React, { memo } from 'react'
import {
  ArrowUpIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import type { ReactElement, ReactNode } from 'react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

import type { ChatInputPrimaryActionKind } from './chatInputInteractionState.pure'

import styles from './ChatInput.module.css'

export interface ComposerToolbarRightChromeProps {
  rightActions?: ReactNode
}

export interface ComposerToolbarRightVoiceProps {
  showVoiceInput: boolean
  voiceInputLabel: string
  voiceInputTitle: string
  voiceInputDisabled: boolean
  isVoiceListening: boolean
  voiceInputSupported: boolean
  voiceButtonClassName: string
  onToggleVoiceInput: () => void
}

export interface ComposerToolbarRightPrimaryActionProps {
  showButton: boolean
  kind: ChatInputPrimaryActionKind
  title: string
  disabled: boolean
  pending: boolean
  buttonClassName: string
  onSendClick: () => void
  onStop?: () => void | Promise<void>
}

export interface ComposerToolbarRightProps {
  chrome: ComposerToolbarRightChromeProps
  submitSlot?: ReactNode
  voice: ComposerToolbarRightVoiceProps
  primaryAction: ComposerToolbarRightPrimaryActionProps
}

function ComposerToolbarRightInner({
  chrome: { rightActions },
  submitSlot,
  voice: {
    showVoiceInput,
    voiceInputLabel,
    voiceInputTitle,
    voiceInputDisabled,
    isVoiceListening,
    voiceInputSupported,
    voiceButtonClassName,
    onToggleVoiceInput,
  },
  primaryAction: {
    showButton,
    kind,
    title,
    disabled,
    pending,
    buttonClassName,
    onSendClick,
    onStop,
  },
}: ComposerToolbarRightProps): ReactElement {
  const actionClick = kind === 'stop' ? onStop : onSendClick
  const actionDisabled = disabled || (kind === 'stop' && !onStop)

  return (
    <Inline className={styles.toolbarRight} gap="sm">
      {rightActions}
      {showVoiceInput && (
        <IconButton
          label={voiceInputLabel}
          title={voiceInputTitle}
          size="icon-sm"
          onClick={onToggleVoiceInput}
          disabled={voiceInputDisabled}
          aria-pressed={isVoiceListening}
          className={voiceButtonClassName}
        >
          {voiceInputSupported ? (
            <MicrophoneIcon size={14} weight={isVoiceListening ? 'fill' : 'regular'} />
          ) : (
            <MicrophoneSlashIcon size={14} />
          )}
        </IconButton>
      )}
      {submitSlot}
      {!submitSlot && showButton && (
        <IconButton
          variant="ghost"
          label={title}
          title={title}
          size="icon"
          onClick={actionClick}
          disabled={actionDisabled}
          className={buttonClassName}
        >
          {kind === 'stop' && !pending ? (
            <span className={styles.stopButtonIcon} aria-hidden />
          ) : pending ? (
            <SpinnerGapIcon size={16} className={styles.spinIcon} />
          ) : (
            <ArrowUpIcon size={16} weight="bold" />
          )}
        </IconButton>
      )}
    </Inline>
  )
}

export const ComposerToolbarRight = memo(ComposerToolbarRightInner)
ComposerToolbarRight.displayName = 'ComposerToolbarRight'
