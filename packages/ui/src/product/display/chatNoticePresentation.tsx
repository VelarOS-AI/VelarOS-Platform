/**
 * 对话内通知条的 tone→图标映射（`ChatInteractionNotice` 的展示辅助）。
 *
 * variants（封闭枚举，全仓共用一套）：`tone` = `running | warning | error`（running 无默认图标）。
 * 纯展示，不含 runtime 推导；随 `ChatInteractionNotice` 同域复用（如对话内 InlineRuntimeNotice）。
 */
import { type ReactElement } from 'react'
import { WarningCircleIcon, XCircleIcon } from '@phosphor-icons/react'

export type ChatNoticeTone = 'running' | 'warning' | 'error'

/** 对话内 notice 条默认 tone 图标（running 无图标）。 */
export function renderChatNoticeToneIcon(
  tone: ChatNoticeTone,
  size = 16
): Nullable<ReactElement> {
  switch (tone) {
    case 'running':
      return null
    case 'warning':
      return <WarningCircleIcon size={size} weight="fill" />
    default:
      return <XCircleIcon size={size} weight="fill" />
  }
}
