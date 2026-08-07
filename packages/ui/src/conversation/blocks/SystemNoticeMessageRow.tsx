import { memo, type ReactElement, useState } from 'react'
import { CaretDownIcon, ClockCounterClockwiseIcon } from '@phosphor-icons/react'

import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n } from '../i18n'

import styles from './MessageBubble.module.css'

import type { ChatMessage } from '#contracts'
import { isBlank } from '#internal/runtime'

/**
 * 系统通知行（`conversationKind: 'system-notice'`）。
 *
 * 这类消息既不是用户说的、也不是模型说的：它是宿主对会话本身做过的事（当前只有回溯）的留痕。
 * 渲染成一条居中的细线通知而不是气泡——它不参与对话，只是一个时间轴上的记号。
 *
 * 第一个文本块是给人看的一行摘要，其余块是给模型看的完整说明（默认折叠）。两者是**同一份文本**
 * 的两段，不是两个真相：模型看到的就是用户展开后能看到的，回溯这种破坏性操作不留暗话。
 */
function SystemNoticeMessageRowInner({ message }: { message: ChatMessage }): Nullable<ReactElement> {
  const { t } = useConversationI18n()
  const [expanded, setExpanded] = useState(false)
  const paragraphs = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter((text) => !isBlank(text))

  if (!paragraphs.length) return null

  const [summary, ...details] = paragraphs

  return (
    <div
      className={styles.systemNoticeRow}
      data-message-id={message.id}
      data-conversation-kind="system-notice"
    >
      <div className={styles.systemNoticeHeader}>
        <ClockCounterClockwiseIcon size={12} className={styles.systemNoticeIcon} />
        <Text className={styles.systemNoticeSummary}>{summary}</Text>
        {!!details.length && (
          <button
            type="button"
            className={styles.systemNoticeToggle}
            aria-expanded={expanded}
            onClick={() => setExpanded((previous) => !previous)}
          >
            {t(expanded ? 'chat.rewindNoticeCollapse' : 'chat.rewindNoticeExpand')}
            <CaretDownIcon
              size={10}
              className={expanded ? styles.systemNoticeCaretOpen : styles.systemNoticeCaret}
            />
          </button>
        )}
      </div>
      {expanded &&
        details.map((detail, index) => (
          <Text key={index} className={styles.systemNoticeDetail}>
            {detail}
          </Text>
        ))}
    </div>
  )
}

export const SystemNoticeMessageRow = memo(SystemNoticeMessageRowInner)

SystemNoticeMessageRow.displayName = 'SystemNoticeMessageRow'
