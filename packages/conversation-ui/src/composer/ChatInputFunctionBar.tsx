import { memo, type ReactElement } from 'react'

import {
  ComposerActiveChipsBar,
  type ComposerActiveChipsBarProps,
} from './ComposerActiveChipsBar'

export interface ChatInputFunctionBarProps extends Omit<ComposerActiveChipsBarProps, 'leading'> {}

function ChatInputFunctionBarInner(props: ChatInputFunctionBarProps): Nullable<ReactElement> {
  return <ComposerActiveChipsBar {...props} />
}

export const ChatInputFunctionBar = memo(ChatInputFunctionBarInner)
ChatInputFunctionBar.displayName = 'ChatInputFunctionBar'
