import { type ReactElement, useState } from 'react'
import { ClockCounterClockwiseIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useLatest, useLockFn } from 'ahooks'

import { StyleUtils } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton, type IconButtonPresetSize } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Checkbox } from '@velaros-ai/ui/primitives/forms/Checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'
import { CopyButton } from '@velaros-ai/ui/product/buttons/CopyButton'

import { useConversationI18n } from '../i18n'
import { useChatToolRenderCapabilities } from '../tool-render/chatToolRenderCapabilitiesContext'

import {
  formatMessageDateTime,
  formatMessageTime,
} from './messageBubbleRenderModel'
import {
  formatMessageCostEstimate,
  type MessageCostEstimate as MessageCostEstimateValue,
} from './messageCostEstimate'
import { formatExactNumber } from './numberFormat'

import styles from './MessageBubble.module.css'

import type { AppLocale } from '#contracts'
import { AppError } from '#internal/result'
import { isBlank } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)

const MESSAGE_ACTION_ICON_SIZE = 'icon-sm' satisfies IconButtonPresetSize

export function MessageCopyButton({
  text,
  label,
  copiedLabel,
}: {
  text: string
  label: string
  copiedLabel: string
}): Nullable<ReactElement> {
  if (isBlank(text)) return null

  return (
    <CopyButton
      value={text}
      label={label}
      copiedLabel={copiedLabel}
      size={MESSAGE_ACTION_ICON_SIZE}
    />
  )
}

export function MessageRewindButton({
  messageId,
  disabled = false,
  onRewind,
  canChooseRewindFiles = false,
}: {
  messageId: string
  disabled?: boolean
  onRewind?: (messageId: string, options?: { restoreFiles?: boolean }) => Promise<void>
  canChooseRewindFiles?: boolean
}): Nullable<ReactElement> {
  const { t } = useConversationI18n()
  const { showNotice } = useChatToolRenderCapabilities()
  const [open, setOpen] = useState(false)
  const [isRewinding, setIsRewinding] = useState(false)
  const [restoreFiles, setRestoreFiles] = useState(false)
  const onRewindLatest = useLatest(onRewind)
  const tLatest = useLatest(t)
  const showNoticeLatest = useLatest(showNotice)

  const handleConfirm = useLockFn(async (): Promise<void> => {
    const rewind = onRewindLatest.current

    if (!rewind) return

    try {
      setIsRewinding(true)
      await rewind(messageId, {
        restoreFiles: canChooseRewindFiles && restoreFiles,
      })
      setOpen(false)
      setRestoreFiles(false)
      showNoticeLatest.current?.({
        title: tLatest.current('chat.rewindSuccessTitle'),
        description: tLatest.current('chat.rewindSuccessDescription'),
        tone: 'success',
        duration: 2600,
      })
    } catch (error) {
      const appError = AppError.from(error)
      showNoticeLatest.current?.({
        title: tLatest.current('chat.rewindErrorTitle'),
        description: appError.message.trim() || tLatest.current('chat.rewindErrorFallback'),
        tone: appError.code === 'VALIDATION' || appError.code === 'NOT_FOUND' ? 'warning' : 'error',
        showClose: true,
      })
    } finally {
      setIsRewinding(false)
    }
  })

  if (!onRewind || disabled) return null

  return (
    <>
      <IconButton
        label={t('chat.rewindToBeforeMessage')}
        variant="ghost"
        size={MESSAGE_ACTION_ICON_SIZE}
        shape="round"
        className={styles.messageRewindButton}
        disabled={isRewinding}
        onClick={() => {
          setRestoreFiles(false)
          setOpen(true)
        }}
      >
        <ClockCounterClockwiseIcon size={14} />
      </IconButton>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!isRewinding) {
            setOpen(nextOpen)
            if (!nextOpen) {
              setRestoreFiles(false)
            }
          }
        }}
      >
        <DialogContent
          className="velar-confirm-dialog"
          showClose={!isRewinding}
          onInteractOutside={(event) => {
            event.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('chat.rewindDialogTitle')}</DialogTitle>
            <DialogDescription>{t('chat.rewindDialogDescription')}</DialogDescription>
          </DialogHeader>
          {canChooseRewindFiles && (
            <label className={styles.rewindFileChoice}>
              <Checkbox
                size="sm"
                checked={restoreFiles}
                disabled={isRewinding}
                aria-label={t('chat.rewindDialogRestoreFiles')}
                onCheckedChange={setRestoreFiles}
              />
              <span>{t('chat.rewindDialogRestoreFiles')}</span>
            </label>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={isRewinding}
              onClick={() => setOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isRewinding}
              onClick={() => {
                void handleConfirm()
              }}
            >
              {isRewinding && (
                <SpinnerGapIcon size={14} className={styles.assistantMemorySpinIcon} />
              )}
              {isRewinding ? t('chat.rewindPendingAction') : t('chat.rewindConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function MessageTimestamp({
  timestamp,
  locale,
  variant = 'default',
}: {
  timestamp: number
  locale: AppLocale
  /** 封闭外貌枚举，取代开放 className 逃生口（§12.9 形态封闭）。 */
  variant?: 'default' | 'user'
}): Nullable<ReactElement> {
  const date = new Date(timestamp)

  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) return null

  const label = formatMessageTime(timestamp, locale)
  const title = formatMessageDateTime(timestamp, locale)

  return (
    <time
      className={cx('messageTimestamp', variant === 'user' && 'userMessageTimestamp')}
      data-chat-virtual-measure-overflow="true"
      dateTime={date.toISOString()}
      title={title}
    >
      {label}
    </time>
  )
}

export function MessageCostEstimate({
  estimate,
  locale,
}: {
  estimate: Nullable<MessageCostEstimateValue>
  locale: AppLocale
}): Nullable<ReactElement> {
  if (!estimate) return null

  const label = formatMessageCostEstimate(locale, estimate.usd)
  const title = `${formatExactNumber(locale, estimate.inputTokens)} input tokens · ${formatExactNumber(locale, estimate.outputTokens)} output tokens`

  return (
    <span className={styles.messageCostEstimate} title={title}>
      {label}
    </span>
  )
}
