import { memo, type ReactElement, type ReactNode } from 'react'

import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

import styles from './ChatInput.module.css'

export interface ChatInputActionRowProps {
  leading: ReactNode
  trailing: ReactNode
}

function ChatInputActionRowInner({ leading, trailing }: ChatInputActionRowProps): ReactElement {
  return (
    <Inline className={styles.toolbar} justify="between">
      {leading}
      {trailing}
    </Inline>
  )
}

export const ChatInputActionRow = memo(ChatInputActionRowInner)
ChatInputActionRow.displayName = 'ChatInputActionRow'
