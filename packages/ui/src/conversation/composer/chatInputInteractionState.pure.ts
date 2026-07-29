import { isBlank, optionalWhen } from '#internal/runtime'
export type ChatInputSendButtonTone = 'active' | 'disabled' | 'submitting'
export type ChatInputPrimaryActionKind = 'send' | 'sending' | 'stop'

export interface ChatInputInteractionStateInput {
  disabled: boolean
  fileCount: number
  hideSubmit: boolean
  isStreaming: boolean
  isSubmitting: boolean
  value: string
  virtualPasteReferenceCount?: number
  /** 其它可独立成一条消息的附带内容数量（如已选中的行内评论），非空时允许空文本发送。 */
  auxiliaryContentCount?: number
}

export interface ChatInputInteractionState {
  canSend: boolean
  composerDisabled: boolean
  sendButtonTone: ChatInputSendButtonTone
}

export interface ChatInputPrimaryActionStateInput {
  disabled: boolean
  fileCount: number
  hideSubmit: boolean
  isRunActive: boolean
  isStopAvailable: boolean
  isStopPending: boolean
  isSubmitting: boolean
  value: string
  virtualPasteReferenceCount?: number
  /** 其它可独立成一条消息的附带内容数量（如已选中的行内评论），非空时允许空文本发送。 */
  auxiliaryContentCount?: number
}

export interface ChatInputPrimaryActionState {
  kind: ChatInputPrimaryActionKind
  showButton: boolean
  canSend: boolean
  disabled: boolean
  pending: boolean
}

export interface ChatInputPrimaryActionStopHandlerInput {
  onStopAvailable: boolean
  handleStopRequest: () => void
}

function hasDraftContent(
  value: string,
  fileCount: number,
  virtualPasteReferenceCount = 0,
  auxiliaryContentCount = 0
): boolean {
  return (
    !isBlank(value) ||
    fileCount > 0 ||
    virtualPasteReferenceCount > 0 ||
    auxiliaryContentCount > 0
  )
}

export function resolveChatInputInteractionState({
  disabled,
  fileCount,
  hideSubmit,
  isStreaming,
  isSubmitting,
  value,
  virtualPasteReferenceCount = 0,
  auxiliaryContentCount = 0,
}: ChatInputInteractionStateInput): ChatInputInteractionState {
  const canSend =
    !hideSubmit &&
    !disabled &&
    !isStreaming &&
    !isSubmitting &&
    hasDraftContent(value, fileCount, virtualPasteReferenceCount, auxiliaryContentCount)

  return {
    canSend,
    composerDisabled: disabled || isSubmitting,
    sendButtonTone: isSubmitting ? 'submitting' : canSend ? 'active' : 'disabled',
  }
}

export function resolveChatInputPrimaryActionState({
  disabled,
  fileCount,
  hideSubmit,
  isRunActive,
  isStopAvailable,
  isStopPending,
  isSubmitting,
  value,
  virtualPasteReferenceCount = 0,
  auxiliaryContentCount = 0,
}: ChatInputPrimaryActionStateInput): ChatInputPrimaryActionState {
  const showButton = !hideSubmit
  const canSend =
    showButton &&
    !disabled &&
    !isRunActive &&
    !isSubmitting &&
    hasDraftContent(value, fileCount, virtualPasteReferenceCount, auxiliaryContentCount)

  if (!showButton)
    return {
      kind: 'send',
      showButton: false,
      canSend: false,
      disabled: true,
      pending: false,
    }

  if (isRunActive && isStopAvailable)
    return {
      kind: 'stop',
      showButton: true,
      canSend: false,
      disabled: isStopPending,
      pending: isStopPending,
    }

  if (isSubmitting || isRunActive)
    return {
      kind: 'sending',
      showButton: true,
      canSend: false,
      disabled: true,
      pending: true,
    }

  return {
    kind: 'send',
    showButton: true,
    canSend,
    disabled: !canSend,
    pending: false,
  }
}

export function resolveChatInputPrimaryActionStopHandler({
  onStopAvailable,
  handleStopRequest,
}: ChatInputPrimaryActionStopHandlerInput): (() => void) | undefined {
  return optionalWhen(onStopAvailable, handleStopRequest)
}
