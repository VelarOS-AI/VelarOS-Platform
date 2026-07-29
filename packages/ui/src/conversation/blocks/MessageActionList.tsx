import { memo, type ReactElement } from 'react'

import type { ConversationMessageActionRow } from '../projection'

import { MessageActionRow } from './MessageActionRow'

import styles from './MessageBubble.module.css'

function MessageActionListInner({
  rows,
  revealLabel,
}: {
  rows: ConversationMessageActionRow[]
  revealLabel: string
}): Nullable<ReactElement> {
  if (!rows.length) return null

  return (
    <div className={styles.actionList}>
      {rows.map((row) => (
        <MessageActionRow
          key={row.item.key}
          item={row.item}
          displayTitle={row.displayTitle}
          onClick={row.onClick}
          onReveal={row.onReveal}
          revealLabel={revealLabel}
        />
      ))}
    </div>
  )
}

export const MessageActionList = memo(MessageActionListInner)
MessageActionList.displayName = 'MessageActionList'
