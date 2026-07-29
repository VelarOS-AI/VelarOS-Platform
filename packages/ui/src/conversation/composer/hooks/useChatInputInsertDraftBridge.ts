import { useEventListener, useMemoizedFn } from 'ahooks'
import type { MutableRefObject, RefObject } from 'react'

import { focusComposerTextareaNextFrame } from '../chatInputComposerFocus.utils'
import {
  appendChatDraftText,
  canClaimChatDraftInsertion,
  claimChatDraftInsertion,
  InsertChatDraftEventName,
} from '../utils/chatDraftInsertion.utils'

import type { TimerScope } from '#internal/timerScope'

export function useChatInputInsertDraftBridge(
  textareaRef: RefObject<Nullable<HTMLTextAreaElement>>,
  valueRef: MutableRefObject<string>,
  onValueChangeLatest: MutableRefObject<(value: string) => void>,
  timers: TimerScope
): void {
  const handleInsertChatDraft = useMemoizedFn((event: Event): void => {
    const textarea = textareaRef.current
    // 同一窗口可能同时挂着多个工作区的 ChatInput。隐藏/禁用的输入框
    // 不能抢先 claim，否则引导会认为草稿已写入，实际可见输入框仍为空。
    if (!canClaimChatDraftInsertion(textarea)) return

    const insertion = claimChatDraftInsertion(event)

    if (!insertion) return

    const nextValue = insertion.replace
      ? insertion.text
      : appendChatDraftText(valueRef.current, insertion.text)
    valueRef.current = nextValue
    onValueChangeLatest.current(nextValue)
    focusComposerTextareaNextFrame(textareaRef, timers)
  })

  useEventListener(InsertChatDraftEventName, handleInsertChatDraft)
}
