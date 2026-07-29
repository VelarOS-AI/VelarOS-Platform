import { useRef, useState } from 'react'
import { useLatest, useMemoizedFn } from 'ahooks'
import type { KeyboardEvent, MutableRefObject, RefObject } from 'react'

import type { ConversationMessageKey as MessageKey } from '../../i18n'
import { focusComposerTextareaWithCaretNextFrame } from '../chatInputComposerFocus.utils'
import { resolveChatInputInteractionState } from '../chatInputInteractionState.pure'
import type {
  ChatInputManualTestPromptOption,
  ChatInputSelectionRange,
  ChatInputSendDraft,
  ChatVirtualPasteReference,
} from '../chatInputTypes'
import { clampChatComposerInput } from '../utils/chatComposerLimits'

import { isBlank, isEmpty } from '#internal/runtime'
import type { TimerScope } from '#internal/timerScope'

export interface ChatInputVoiceInsertBridge {
  voiceBaseValueRef: MutableRefObject<string>
  isVoiceListening: () => boolean
}

export interface UseChatInputDraftActionsParams {
  value: string
  valueRef: MutableRefObject<string>
  onValueChange: (value: string) => void
  onSelectionChange?: (selection: ChatInputSelectionRange) => void
  files: File[]
  filesRef: MutableRefObject<File[]>
  virtualPasteReferences: readonly ChatVirtualPasteReference[]
  virtualPasteReferencesRef: MutableRefObject<readonly ChatVirtualPasteReference[]>
  /** 可独立成一条消息的附带内容数量（如已选中的行内评论），非空时允许空文本发送。 */
  auxiliaryContentCount?: number
  textareaRef: RefObject<Nullable<HTMLTextAreaElement>>
  disabled: boolean
  hideSubmit: boolean
  isStreaming: boolean
  onSend: (draft?: ChatInputSendDraft) => void | Promise<void>
  isComposing: MutableRefObject<boolean>
  voiceInsertBridgeRef: MutableRefObject<Nullable<ChatInputVoiceInsertBridge>>
  setComposerMenuOpenState: (open: boolean) => void
  onInputLimitExceeded?: () => void
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  timers: TimerScope
}

export interface UseChatInputDraftActionsResult {
  requestSend: (draft?: ChatInputSendDraft) => Promise<void>
  enqueueVoiceSendDraft: (nextValue: string) => void
  isSubmitting: boolean
  handleKeyDown: (e: KeyboardEvent) => void
  handleSelectManualTestPrompt: (option: ChatInputManualTestPromptOption) => void
  insertTextAtCursor: (text: string) => void
  canSend: boolean
  sendButtonTitle: string
}

export function useChatInputDraftActions({
  value,
  valueRef,
  onValueChange,
  onSelectionChange,
  files,
  filesRef,
  virtualPasteReferences,
  virtualPasteReferencesRef,
  auxiliaryContentCount = 0,
  textareaRef,
  disabled,
  hideSubmit,
  isStreaming,
  onSend,
  isComposing,
  voiceInsertBridgeRef,
  setComposerMenuOpenState,
  onInputLimitExceeded,
  t,
  timers,
}: UseChatInputDraftActionsParams): UseChatInputDraftActionsResult {
  const onSendLatest = useLatest(onSend)
  const disabledLatest = useLatest(disabled)
  const isStreamingLatest = useLatest(isStreaming)
  const hideSubmitLatest = useLatest(hideSubmit)
  const onInputLimitExceededLatest = useLatest(onInputLimitExceeded)
  const onSelectionChangeLatest = useLatest(onSelectionChange)

  const isSubmittingRef = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const requestSend = useMemoizedFn(async (draft?: ChatInputSendDraft): Promise<void> => {
    if (isSubmittingRef.current || disabledLatest.current || hideSubmitLatest.current) return

    const sendDraft = draft ?? {
      value: valueRef.current,
      files: filesRef.current,
      virtualPasteReferences: [...virtualPasteReferencesRef.current],
    }
    const limitedValue = clampChatComposerInput(sendDraft.value ?? '')
    if (limitedValue.truncated) {
      onInputLimitExceededLatest.current?.()
    }

    isSubmittingRef.current = true
    setIsSubmitting(true)

    try {
      await onSendLatest.current({
        ...sendDraft,
        value: limitedValue.value,
      })
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  })

  const enqueueVoiceSendDraft = useMemoizedFn((nextValue: string): void => {
    if (
      disabledLatest.current ||
      isStreamingLatest.current ||
      hideSubmitLatest.current ||
      isSubmittingRef.current
    )
      return

    const nextFiles = filesRef.current
    const nextVirtualPasteReferences = virtualPasteReferencesRef.current

    const limitedValue = clampChatComposerInput(nextValue)
    if (limitedValue.truncated) {
      onInputLimitExceededLatest.current?.()
    }

    if (
      isBlank(limitedValue.value.trim()) &&
      !nextFiles.length &&
      isEmpty(nextVirtualPasteReferences)
    )
      return

    void requestSend({
      value: limitedValue.value,
      files: nextFiles,
      virtualPasteReferences: [...nextVirtualPasteReferences],
    })
  })

  function insertTextAtCursor(text: string): void {
    const textarea = textareaRef.current
    const bridge = voiceInsertBridgeRef.current

    if (!textarea) {
      const limitedValue = clampChatComposerInput(`${value}${text}`)
      if (limitedValue.truncated) {
        onInputLimitExceededLatest.current?.()
      }
      onValueChange(limitedValue.value)
      onSelectionChangeLatest.current?.({
        start: limitedValue.value.length,
        end: limitedValue.value.length,
      })
      return
    }

    const selectionStart = textarea.selectionStart ?? value.length
    const selectionEnd = textarea.selectionEnd ?? value.length
    const prefix = value.slice(0, selectionStart)
    const rawNextValue = `${prefix}${text}${value.slice(selectionEnd)}`
    const limitedValue = clampChatComposerInput(rawNextValue)
    const nextValue = limitedValue.value
    const nextCursor = Math.min(prefix.length + text.length, nextValue.length)

    if (limitedValue.truncated) {
      onInputLimitExceededLatest.current?.()
    }
    valueRef.current = nextValue
    if (bridge && !bridge.isVoiceListening()) {
      bridge.voiceBaseValueRef.current = nextValue
    }
    onValueChange(nextValue)
    onSelectionChangeLatest.current?.({
      start: nextCursor,
      end: nextCursor,
    })

    focusComposerTextareaWithCaretNextFrame(textareaRef, nextCursor, timers)
  }

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (isComposing.current) return
    if (!hideSubmit && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (
        !disabled &&
        !isSubmitting &&
        (!isBlank(value) ||
          !!files.length ||
          !isEmpty(virtualPasteReferences) ||
          auxiliaryContentCount > 0)
      )
        void requestSend()
    }
  }

  function handleSelectManualTestPrompt(option: ChatInputManualTestPromptOption): void {
    const bridge = voiceInsertBridgeRef.current
    const limitedPrompt = clampChatComposerInput(option.prompt)
    if (limitedPrompt.truncated) {
      onInputLimitExceededLatest.current?.()
    }
    valueRef.current = limitedPrompt.value
    if (bridge && !bridge.isVoiceListening()) {
      bridge.voiceBaseValueRef.current = limitedPrompt.value
    }
    onValueChange(limitedPrompt.value)
    onSelectionChangeLatest.current?.({
      start: limitedPrompt.value.length,
      end: limitedPrompt.value.length,
    })
    setComposerMenuOpenState(false)
    focusComposerTextareaWithCaretNextFrame(textareaRef, limitedPrompt.value.length, timers)
  }

  const { canSend } = resolveChatInputInteractionState({
    disabled,
    fileCount: files.length,
    hideSubmit,
    isStreaming,
    isSubmitting,
    value,
    virtualPasteReferenceCount: virtualPasteReferences.length,
    auxiliaryContentCount,
  })
  const sendButtonTitle = isSubmitting ? t('chat.sendingMessage') : t('chat.sendMessage')

  return {
    requestSend,
    enqueueVoiceSendDraft,
    isSubmitting,
    handleKeyDown,
    handleSelectManualTestPrompt,
    insertTextAtCursor,
    canSend,
    sendButtonTitle,
  }
}
