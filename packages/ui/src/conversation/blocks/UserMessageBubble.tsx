import { memo, type ReactElement, useEffect, useMemo, useState } from 'react'
import { CursorClickIcon, PulseIcon, SignpostIcon, UsersThreeIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { ImagePreviewDialog } from '@velaros-ai/ui/primitives/overlays/ImagePreviewDialog'

import { useConversationI18n } from '../i18n'
import type { ConversationRewindPlan } from '../projection'
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
import { buildMessageClipboardContent } from './messageClipboard'
import { UserAttachmentGallery } from './UserAttachmentGallery'

import styles from './MessageBubble.module.css'

import type {
  ChatAttachmentMeta,
  ChatMessage,
  SerializedImageAttachment,
} from '#contracts'
import {
  isConversationTurnInputMessage,
  isRunGuidanceMessage,
  resolveChatMessageConversationKind,
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
  onRewindToMessage,
  canRewindToMessage = true,
  getRewindPlan,
}: {
  message: ChatMessage
  onRewindToMessage?: (messageId: string, options?: { restoreFiles?: boolean }) => Promise<void>
  canRewindToMessage?: boolean
  getRewindPlan?: (messageId: string) => Nullable<ConversationRewindPlan>
}): ReactElement {
  const { t, locale } = useConversationI18n()
  const imagePreviewMessages = useImagePreviewDialogMessages()
  const copyText = useMemo(() => extractMessageText(message), [message])
  const clipboardContent = useMemo(() => buildMessageClipboardContent(message), [message])
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
  const isRunGuidance = isRunGuidanceMessage(message)
  // 注意这里**不带** canRewindToMessage：确认框是 MessageRewindButton 的子树，把它的挂载条件
  // 绑在「会话是否 idle」上，会让一个已经打开、用户已经选好选项的弹窗在会话转为运行中时凭空消失
  // （hook 自驱、定时任务、排队提交 flush 都能在用户盯着弹窗时把会话推成非 idle）。
  // 能不能回退由按钮内部按 disabled 处理：图标隐藏，但已打开的弹窗留着并禁用确认。
  const canShowRewindAction = isConversationTurnInputMessage(message) && !!onRewindToMessage
  const hasUserActions = canShowRewindAction || !isBlank(clipboardContent.plainText)
  const guidanceStatus = message.guidanceStatus ?? (isRunGuidance ? 'sent' : null)
  const guidanceLabel =
    guidanceStatus === 'awaiting-decision'
      ? t('chat.awaitingUserDecision')
      : guidanceStatus === 'pending'
        ? t('chat.guidingConversation')
        : guidanceStatus === 'sent'
          ? t('chat.guidedConversation')
          : null
  // 同伴署名：这条 user 消息是同组另一条会话写的，不是用户本人。
  //
  // 与引导标签**互斥且优先**：一条消息不可能既是用户的运行中引导、又是同伴投来的，而万一两个
  // 字段同时出现（旧数据 / 上游拼装出错），"这不是用户说的"是更要紧的那条信息——先让人知道
  // 作者是谁，再谈它是不是引导。
  const peerOrigin = message.peerOrigin
  const peerLabel = peerOrigin
    ? t('chat.peerMessageFrom', { name: peerOrigin.title ?? peerOrigin.sessionId })
    : null
  const statusLabel = peerLabel ?? guidanceLabel
  const statusIcon = peerLabel ? (
    <UsersThreeIcon size={11} weight="fill" className={styles.guidedInputLabelIcon} />
  ) : (
    !!guidanceLabel && (
      <SignpostIcon
        size={11}
        weight={guidanceStatus === 'sent' ? 'fill' : 'regular'}
        className={styles.guidedInputLabelIcon}
      />
    )
  )
  return (
    <div
      className={cx('root', 'user')}
      data-message-id={message.id}
      data-message-role={message.role}
      data-conversation-kind={resolveChatMessageConversationKind(message)}
    >
      <div className={styles.userRow}>
        {(hasUserActions || statusLabel) && (
          <div
            className={cx(
              'userLeftMeta',
              optionalWhenLazy(statusLabel, () => 'userLeftMetaWithGuidance')
            )}
          >
            {hasUserActions && (
              <div className={styles.userCopySlot}>
                {canShowRewindAction && (
                  <MessageRewindButton
                    messageId={message.id}
                    disabled={!canRewindToMessage}
                    onRewind={onRewindToMessage}
                    getRewindPlan={getRewindPlan}
                  />
                )}
                {(!isBlank(clipboardContent.plainText) || clipboardContent.assets.length > 0) && (
                  <MessageCopyButton
                    content={clipboardContent}
                    label={t(isRunGuidance ? 'chat.copyGuidance' : 'chat.copyPrompt')}
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
