import { useEventListener, useMemoizedFn } from 'ahooks'
import type { RefObject } from 'react'

import { canClaimChatDraftInsertion } from '../utils/chatDraftInsertion.utils'
import {
  ActivateChatPromptFeatureEventName,
  claimChatPromptFeatureActivation,
} from '../utils/chatPromptFeatureActivation.utils'

import type { ChatPromptFeatureId } from '#contracts'

export function useChatInputPromptFeatureActivationBridge(
  textareaRef: RefObject<Nullable<HTMLTextAreaElement>>,
  selectedPromptFeatures: ReadonlySet<ChatPromptFeatureId>,
  updatePromptFeature: (feature: ChatPromptFeatureId, enabled: boolean) => void
): void {
  const handleActivation = useMemoizedFn((event: Event): void => {
    if (!canClaimChatDraftInsertion(textareaRef.current)) return

    const feature = claimChatPromptFeatureActivation(event)
    if (!feature || selectedPromptFeatures.has(feature)) return

    updatePromptFeature(feature, true)
  })

  useEventListener(ActivateChatPromptFeatureEventName, handleActivation)
}
