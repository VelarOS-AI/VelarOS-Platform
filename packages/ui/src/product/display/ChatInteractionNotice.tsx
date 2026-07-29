/**
 * 对话内轻量通知条（等待 / 警告 / 错误）——纯展示，不含 runtime 推导。
 *
 * variants（封闭枚举，全仓共用一套）：`tone` = `running | warning | error`。
 * 样式：`.velar-chat-notice` · 见 styles/components/。
 * 明文禁绑 IPC / ChatRuntimeState：由上层传入 title / description / tone / actions。
 */
import { type ReactElement, type ReactNode } from 'react'

import { cn } from '../../lib/cn'
import { Inline } from '../../primitives/layout/Inline'

import {
  type ChatNoticeTone,
  renderChatNoticeToneIcon,
} from './chatNoticePresentation'

export type ChatInteractionNoticeTone = ChatNoticeTone

export interface ChatInteractionNoticeProps {
  tone: ChatInteractionNoticeTone
  title: ReactNode
  description: ReactNode
  icon?: ReactNode
  actions?: ReactNode
}

export function ChatInteractionNotice(props: ChatInteractionNoticeProps): ReactElement {
  const { tone, title, description, actions } = props
  const resolvedIcon = 'icon' in props ? props.icon : renderChatNoticeToneIcon(tone)

  return (
    <div className={cn('velar-chat-notice', `velar-chat-notice-${tone}`)}>
      {!!resolvedIcon && <div className="velar-chat-notice-icon">{resolvedIcon}</div>}
      <div className="velar-chat-notice-body">
        <div className="velar-chat-notice-title">{title}</div>
        <div className="velar-chat-notice-description">{description}</div>
        {!!actions && (
          <Inline className="velar-chat-notice-actions" gap="sm">
            {actions}
          </Inline>
        )}
      </div>
    </div>
  )
}
