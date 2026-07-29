import type { ChatPromptFeatureId } from '#contracts'
import { PromptFeatureOrder } from '#internal/promptFeatures'
import { isString } from '#internal/runtime'

export const ActivateChatPromptFeatureEventName = 'velaros:activate-chat-prompt-feature'

interface ActivateChatPromptFeatureEventDetail {
  feature?: unknown
  handled?: boolean
}

/** 请求当前可见输入框开启一项会话能力，返回是否已被消费。 */
export function requestActivateChatPromptFeature(feature: ChatPromptFeatureId): boolean {
  const detail: ActivateChatPromptFeatureEventDetail = { feature, handled: false }
  window.dispatchEvent(new CustomEvent(ActivateChatPromptFeatureEventName, { detail }))
  return !!detail.handled
}

/** 多工作区共存时，由当前可见 ChatInput 独占消费。 */
export function claimChatPromptFeatureActivation(event: Event): Nullable<ChatPromptFeatureId> {
  if (!(event instanceof CustomEvent)) return null

  const detail = event.detail as Nullable<ActivateChatPromptFeatureEventDetail>
  if (!detail || detail.handled || !isString(detail.feature)) return null

  const feature = detail.feature as ChatPromptFeatureId
  if (!PromptFeatureOrder.includes(feature)) return null

  detail.handled = true
  return feature
}
