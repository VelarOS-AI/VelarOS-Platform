import { isBlank, isString } from '#internal/runtime'
export const InsertChatDraftEventName = 'velaros:insert-chat-draft'

interface InsertChatDraftEventDetail {
  text?: any
  handled?: boolean
  replace?: boolean
}

export interface ClaimedChatDraftInsertion {
  text: string
  replace: boolean
}

type ChatDraftInsertionTarget = Pick<
  HTMLTextAreaElement,
  'disabled' | 'getClientRects' | 'isConnected'
>

/** 多工作区共存时，只允许当前可见且可编辑的输入框消费全局草稿事件。 */
export function canClaimChatDraftInsertion(
  target: Nullable<ChatDraftInsertionTarget>
): target is ChatDraftInsertionTarget {
  return !!(target && target.isConnected && !target.disabled && target.getClientRects().length > 0)
}

export function appendChatDraftText(currentValue: string, text: string): string {
  return isBlank(currentValue) ? text : `${currentValue.trimEnd()}\n\n${text}`
}

/**
 * 派发一次「插入聊天草稿」事件；返回是否已有挂载中的 ChatInput 消费。
 * 跨页跳转（如设置页 → 聊天页）时输入框可能尚未挂载，调用方可据返回值重试。
 */
export function requestInsertChatDraft(text: string, options?: { replace?: boolean }): boolean {
  const detail: InsertChatDraftEventDetail = {
    text,
    handled: false,
    replace: options?.replace,
  }
  window.dispatchEvent(new CustomEvent(InsertChatDraftEventName, { detail }))
  return detail.handled === true
}

export function claimChatDraftInsertion(event: Event): Nullable<ClaimedChatDraftInsertion> {
  if (!(event instanceof CustomEvent)) return null

  const detail = event.detail as Nullable<InsertChatDraftEventDetail>
  if (!detail || detail.handled) return null

  const text = isString(detail.text) ? detail.text : ''
  const replace = !!detail.replace
  if (isBlank(text) && !replace) return null

  detail.handled = true
  return { text, replace }
}
