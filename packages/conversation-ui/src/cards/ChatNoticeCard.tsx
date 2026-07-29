import { memo, type ReactElement, type ReactNode } from 'react'

import { ChatInteractionNotice } from '@velaros-ai/ui'

import { useConversationI18n, useConversationTranslatorRuntime } from '../i18n'
import { type ChatNoticeMeta, type ChatStatusRuntime, getChatNoticeMeta } from '../status/chatStatus'

interface ChatNoticeCardProps {
  runtime: ChatStatusRuntime
  notice?: LooseOptional<ChatNoticeMeta>
  actions?: ReactNode
}

function ChatNoticeCardInner({
  runtime,
  notice: overrideNotice,
  actions,
}: ChatNoticeCardProps): Nullable<ReactElement> {
  const { locale } = useConversationI18n()
  const translatorRuntime = useConversationTranslatorRuntime()
  const notice = overrideNotice ?? getChatNoticeMeta(runtime, locale, translatorRuntime)

  if (!notice) return null

  return (
    <ChatInteractionNotice
      tone={notice.tone}
      title={notice.title}
      description={notice.description}
      actions={actions}
    />
  )
}

export const ChatNoticeCard = memo(ChatNoticeCardInner)
ChatNoticeCard.displayName = 'ChatNoticeCard'
