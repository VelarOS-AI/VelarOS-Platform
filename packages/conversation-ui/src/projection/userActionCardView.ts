import type {
  ContentBlock,
  UserActionCardAction,
  UserActionFormField,
  UserActionFormValue,
} from '#contracts'

/**
 * `UserActionCardView` — user-action 卡渲染件（`UserActionCard` / `AskUserCarousel`）消费的
 * **viewmodel 输出投影**。
 *
 * 卡的交互状态机（超时锚定 / localStorage 消费标记 / prompt-features 事件派发 / 定时器）住在宿主
 * hook `useUserActionCardViewModel`——它触达 `window` / localStorage / timers，不进包。包只声明 hook
 * 的**输出形状**：宿主 hook 的返回类型即本投影（单源），渲染件收 `view: UserActionCardView` prop，
 * 不再自持 hook。字段面即卡渲染实际消费面（§12.8）。
 */

export type FormDraftValue = string | boolean | string[]
export type FormDraftValues = Record<string, FormDraftValue>
export type FormErrors = Record<string, string>

export interface UserActionEntry {
  action: UserActionCardAction
  key: string
}

export type UserActionResolution = {
  actionKind: UserActionCardAction['kind'] | 'timeout' | 'skip'
  approved: boolean
  message?: string
  values?: Record<string, UserActionFormValue>
  timedOut?: boolean
}

export interface UserActionCardTimeoutHandlers {
  onActionComplete?: (resolution: UserActionResolution) => void | Promise<void>
  onDismiss?: () => void
}

type UserActionCardData = Extract<ContentBlock, { type: 'user-action-card' }>['card']

export interface UserActionCardView {
  card: UserActionCardData
  isHidden: boolean
  isConsumed: boolean
  isTimedOut: boolean
  interactionDisabled: boolean
  formFields: UserActionFormField[]
  actionEntries: UserActionEntry[]
  completedActionKey: Nullable<string>
  pendingActionKey: Nullable<string>
  settled: boolean
  formValues: FormDraftValues
  formErrors: FormErrors
  inputValue: string
  timeoutPaused: boolean
  effectiveTimeoutMs: Nullable<number>
  activeInputEntry: Nullable<UserActionEntry>
  completedEntry: Nullable<UserActionEntry>
  shouldShowCardActions: boolean
  shouldShowSkipButton: boolean
  setInputValue: (value: string) => void
  setTimeoutPaused: (paused: boolean) => void
  handleFormFieldChange: (fieldId: string, value: FormDraftValue) => void
  submitAction: (entry: UserActionEntry, message?: string) => void
  skipCard: () => void
  cancelInput: () => void
  isInputSubmitDisabled: (entry: UserActionEntry) => boolean
  isActionButtonDisabled: (entry: UserActionEntry) => boolean
  isFormDisabled: boolean
  isInputPanelDisabled: boolean
}
