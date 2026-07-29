import { memo, type ReactElement, useEffect, useMemo, useState } from 'react'
import { CursorClickIcon, PulseIcon, SignpostIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { ImagePreviewDialog } from '@velaros-ai/ui/primitives/overlays/ImagePreviewDialog'

import { useConversationI18n } from '../i18n'
import { useImagePreviewDialogMessages } from '../react-hooks/useImagePreviewDialogMessages'

import {
  MessageCopyButton,
  MessageRewindButton,
  MessageTimestamp,
} from './MessageBubbleActions'
import {
  buildPreviewItems,
  extractMessageText,
} from './messageBubbleRenderModel'
import { UserAttachmentGallery } from './UserAttachmentGallery'

import styles from './MessageBubble.module.css'

import type {
  ChatAttachmentMeta,
  ChatMessage,
  SerializedImageAttachment,
} from '#contracts'
import { isBlank, isEmpty, isPresent, optionalWhenLazy } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)
const EmptyAttachments: ChatAttachmentMeta[] = []
const EmptyImageAttachments: SerializedImageAttachment[] = []
const EmptyBrowserElementSelections: NonNullable<ChatMessage['browserElementSelections']> = []

function formatBrowserElementChipTitle(
  selection: NonNullable<ChatMessage['browserElementSelections']>[number],
  stepLabel: string
): string {
  let title = ''
  const appendPart = (value: LooseOptional<string>): void => {
    if (!value) return
    title = title ? `${title} · ${value}` : value
  }

  appendPart(selection.label)
  appendPart(
    selection.interactionSteps?.length ? `${selection.interactionSteps.length} ${stepLabel}` : null
  )
  appendPart(`${selection.rect.centerX},${selection.rect.centerY}`)

  return title
}

function UserMessageBubbleInner({
  message,
  isGuidedInput = false,
  onRewindToMessage,
  canRewindToMessage = true,
  canChooseRewindFiles = false,
}: {
  message: ChatMessage
  isGuidedInput?: boolean
  onRewindToMessage?: (messageId: string, options?: { restoreFiles?: boolean }) => Promise<void>
  canRewindToMessage?: boolean
  canChooseRewindFiles?: boolean
}): ReactElement {
  const { t, locale } = useConversationI18n()
  const imagePreviewMessages = useImagePreviewDialogMessages()
  const copyText = useMemo(() => extractMessageText(message), [message])
  const attachments = message.attachments ?? EmptyAttachments
  const imageAttachments = message.serialized?.imageAttachments ?? EmptyImageAttachments
  const browserElementSelections = message.browserElementSelections ?? EmptyBrowserElementSelections
  const [previewOpenIndex, setPreviewOpenIndex] = useState<Nullable<number>>(null)
  const previewItems = useMemo(
    () => buildPreviewItems(attachments, imageAttachments),
    [attachments, imageAttachments]
  )
  useEffect(() => {
    if (!isPresent(previewOpenIndex)) return

    if (previewOpenIndex >= previewItems.length) {
      setPreviewOpenIndex(previewItems.length ? previewItems.length - 1 : null)
    }
  }, [previewItems.length, previewOpenIndex])
  const canShowRewindAction = !!onRewindToMessage && canRewindToMessage
  const hasUserActions = canShowRewindAction || !isBlank(copyText)
  const guidanceStatus = message.guidanceStatus ?? (isGuidedInput ? 'sent' : null)
  const guidanceLabel =
    guidanceStatus === 'awaiting-decision'
      ? t('chat.awaitingUserDecision')
      : guidanceStatus === 'pending'
        ? t('chat.guidingConversation')
        : guidanceStatus === 'sent'
          ? t('chat.guidedConversation')
          : null
  const statusLabel = guidanceLabel
  const statusIcon = !!guidanceLabel && (
    <SignpostIcon
      size={11}
      weight={guidanceStatus === 'sent' ? 'fill' : 'regular'}
      className={styles.guidedInputLabelIcon}
    />
  )
  return (
    <div
      className={cx('root', 'user')}
      data-message-id={message.id}
      data-message-role={message.role}
      data-guided-input={isGuidedInput}
    >
      <div className={styles.userRow}>
        {(hasUserActions || guidanceLabel) && (
          <div
            className={cx(
              'userLeftMeta',
              optionalWhenLazy(guidanceLabel, () => 'userLeftMetaWithGuidance')
            )}
          >
            {hasUserActions && (
              <div className={styles.userCopySlot}>
                {canShowRewindAction && (
                  <MessageRewindButton
                    messageId={message.id}
                    disabled={!canRewindToMessage}
                    onRewind={onRewindToMessage}
                    canChooseRewindFiles={canChooseRewindFiles}
                  />
                )}
                {!isBlank(copyText) && (
                  <MessageCopyButton
                    text={copyText}
                    label={t('chat.copyPrompt')}
                    copiedLabel={t('chat.codeBlockCopied')}
                  />
                )}
              </div>
            )}
            {statusLabel && (
              <div className={styles.guidedInputLabel} title={statusLabel}>
                {statusIcon}
                <Text>{statusLabel}</Text>
              </div>
            )}
          </div>
        )}
        <div className={styles.userBubble}>
          <div className={styles.userBubbleInner}>
            <UserAttachmentGallery
              attachments={attachments}
              imageAttachments={imageAttachments}
              previewLabel={t('chat.openImagePreview')}
              onPreviewImage={setPreviewOpenIndex}
            />
            {!!message.turnContext && !isEmpty(message.turnContext.chips) && (
              <div
                className={styles.userBrowserElementList}
                aria-label={t('common.environmentContext')}
              >
                {message.turnContext.chips.map((chip, index) => (
                  <span
                    key={`${chip.sourceId}-${index}`}
                    className={styles.userBrowserElementChip}
                    title={chip.sourceId}
                  >
                    <PulseIcon size={13} weight="bold" className={styles.userBrowserElementIcon} />
                    <span className={styles.userBrowserElementLabel}>{chip.label}</span>
                  </span>
                ))}
              </div>
            )}
            {!isEmpty(browserElementSelections) && (
              <div className={styles.userBrowserElementList} aria-label={t('browser.pickElement')}>
                {browserElementSelections.map((selection) => (
                  <span
                    key={selection.id}
                    className={styles.userBrowserElementChip}
                    title={formatBrowserElementChipTitle(
                      selection,
                      t('browser.elementPickerSteps')
                    )}
                  >
                    <CursorClickIcon
                      size={13}
                      weight="bold"
                      className={styles.userBrowserElementIcon}
                    />
                    <span className={styles.userBrowserElementLabel}>{selection.label}</span>
                    {!!selection.interactionSteps?.length && (
                      <span className={styles.userBrowserElementMeta}>
                        {selection.interactionSteps.length} {t('browser.elementPickerSteps')}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            )}
            {!isBlank(copyText) && (
              <Paragraph spacing="none" className={styles.textContent}>
                {copyText}
              </Paragraph>
            )}
          </div>
        </div>
        <MessageTimestamp timestamp={message.timestamp} locale={locale} variant="user" />
        <ImagePreviewDialog
          items={previewItems}
          openIndex={previewOpenIndex}
          onOpenIndexChange={setPreviewOpenIndex}
          messages={imagePreviewMessages}
        />
      </div>
    </div>
  )
}

export const UserMessageBubble = memo(UserMessageBubbleInner)

UserMessageBubble.displayName = 'UserMessageBubble'
