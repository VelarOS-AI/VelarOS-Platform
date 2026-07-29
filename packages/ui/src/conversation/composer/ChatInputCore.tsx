import { memo, type ReactElement, type ReactNode } from 'react'

import styles from './ChatInput.module.css'

export interface ChatInputCoreProps {
  filePreview: ReactNode
  topSlot?: ReactNode
  inputArea: ReactNode
}

function ChatInputCoreInner({ filePreview, topSlot, inputArea }: ChatInputCoreProps): ReactElement {
  return (
    <>
      {filePreview}
      {topSlot}
      <div className={styles.textareaWrapper}>{inputArea}</div>
    </>
  )
}

export const ChatInputCore = memo(ChatInputCoreInner)
ChatInputCore.displayName = 'ChatInputCore'
