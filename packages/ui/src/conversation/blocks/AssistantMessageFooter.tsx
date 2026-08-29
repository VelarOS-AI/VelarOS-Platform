import { memo, type ReactElement, useMemo } from 'react'

import {
  MessageCopyButton,
  MessageCostEstimate,
  MessageTimestamp,
} from './MessageBubbleActions'
import { buildMessageClipboardContent } from './messageClipboard'
import type { MessageCostEstimate as MessageCostEstimateValue } from './messageCostEstimate'

import styles from './MessageBubble.module.css'

import type { AppLocale, ChatMessage } from '#contracts'
import { isBlank } from '#internal/runtime'

function AssistantMessageFooterInner({
  message,
  answerCostEstimate,
  copyLabel,
  copiedLabel,
  locale,
}: {
  message: ChatMessage
  answerCostEstimate: Nullable<MessageCostEstimateValue>
  copyLabel: string
  copiedLabel: string
  locale: AppLocale
}): Nullable<ReactElement> {
  const clipboardContent = useMemo(() => buildMessageClipboardContent(message), [message])
  if (isBlank(clipboardContent.plainText) && clipboardContent.assets.length === 0) return null

  return (
    <div className={styles.assistantCopyFooter}>
      <MessageCopyButton content={clipboardContent} label={copyLabel} copiedLabel={copiedLabel} />
      <div className={styles.assistantMessageMeta}>
        <MessageCostEstimate estimate={answerCostEstimate} locale={locale} />
        <MessageTimestamp timestamp={message.timestamp} locale={locale} />
      </div>
    </div>
  )
}

export const AssistantMessageFooter = memo(AssistantMessageFooterInner)

AssistantMessageFooter.displayName = 'AssistantMessageFooter'
