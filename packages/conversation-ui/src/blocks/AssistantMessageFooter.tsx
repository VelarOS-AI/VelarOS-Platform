import { memo, type ReactElement } from 'react'

import {
  MessageCopyButton,
  MessageCostEstimate,
  MessageTimestamp,
} from './MessageBubbleActions'
import type { MessageCostEstimate as MessageCostEstimateValue } from './messageCostEstimate'

import styles from './MessageBubble.module.css'

import type { AppLocale, ChatMessage } from '#contracts'
import { isBlank } from '#internal/runtime'

function AssistantMessageFooterInner({
  message,
  answerText,
  answerCostEstimate,
  copyLabel,
  copiedLabel,
  locale,
}: {
  message: ChatMessage
  answerText: string
  answerCostEstimate: Nullable<MessageCostEstimateValue>
  copyLabel: string
  copiedLabel: string
  locale: AppLocale
}): Nullable<ReactElement> {
  if (isBlank(answerText)) return null

  return (
    <div className={styles.assistantCopyFooter}>
      <MessageCopyButton text={answerText} label={copyLabel} copiedLabel={copiedLabel} />
      <div className={styles.assistantMessageMeta}>
        <MessageCostEstimate estimate={answerCostEstimate} locale={locale} />
        <MessageTimestamp timestamp={message.timestamp} locale={locale} />
      </div>
    </div>
  )
}

export const AssistantMessageFooter = memo(AssistantMessageFooterInner)

AssistantMessageFooter.displayName = 'AssistantMessageFooter'
