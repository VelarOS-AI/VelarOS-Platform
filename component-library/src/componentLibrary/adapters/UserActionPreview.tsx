import { type ReactElement, useCallback, useMemo, useState } from 'react'

import {
  AskUserCarousel as AskUserCarouselContent,
  type FormDraftValue,
  type FormDraftValues,
  UserActionCard as UserActionCardContent,
  type UserActionCardView,
  type UserActionEntry,
  type UserActionResolution,
} from '@velaros-ai/ui/conversation'

type UserActionBlock = {
  type: 'user-action-card'
  card: UserActionCardView['card']
}
type UserActionFormValue = NonNullable<UserActionResolution['values']>[string]

function createInitialFormValues(block: UserActionBlock): FormDraftValues {
  return Object.fromEntries(
    (block.card.form?.fields ?? []).map((field) => {
      const initialValue =
        field.type === 'checkboxes' ? [] : field.type === 'checkbox' ? false : ''
      return [field.id, initialValue]
    })
  )
}

function usePreviewUserActionView({
  block,
  disabled,
  onActionComplete,
}: {
  block: UserActionBlock
  disabled: boolean
  onActionComplete?: (resolution: UserActionResolution) => void | Promise<void>
}): UserActionCardView {
  const [formValues, setFormValues] = useState<FormDraftValues>(() =>
    createInitialFormValues(block)
  )
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [inputValue, setInputValue] = useState('')
  const [activeInputKey, setActiveInputKey] = useState<string | null>(null)
  const [completedActionKey, setCompletedActionKey] = useState<string | null>(null)
  const [timeoutPaused, setTimeoutPaused] = useState(false)
  const actionEntries = useMemo<UserActionEntry[]>(
    () =>
      block.card.actions.map((action, index) => ({
        action,
        key: `${action.kind}-${index}`,
      })),
    [block.card.actions]
  )
  const activeInputEntry =
    actionEntries.find((entry) => entry.key === activeInputKey) ?? null
  const settled = completedActionKey !== null

  const handleFormFieldChange = useCallback((fieldId: string, value: FormDraftValue): void => {
    setFormValues((current) => ({ ...current, [fieldId]: value }))
    setFormErrors((current) => {
      if (!current[fieldId]) return current
      const next = { ...current }
      delete next[fieldId]
      return next
    })
  }, [])

  const submitAction = useCallback(
    (entry: UserActionEntry, message?: string): void => {
      const actionHasInput =
        (entry.action.kind === 'reject' || entry.action.kind === 'submit_input') &&
        !!entry.action.input
      if (actionHasInput && message === undefined && activeInputKey !== entry.key) {
        setActiveInputKey(entry.key)
        return
      }

      if (entry.action.kind === 'submit_form') {
        const missing = (block.card.form?.fields ?? []).filter((field) => {
          if (!field.required) return false
          const value = formValues[field.id]
          return Array.isArray(value) ? value.length === 0 : value === '' || value === false
        })
        if (missing.length) {
          setFormErrors(
            Object.fromEntries(missing.map((field) => [field.id, '请完成此项后继续']))
          )
          return
        }
      }

      setCompletedActionKey(entry.key)
      setActiveInputKey(null)
      void onActionComplete?.({
        actionKind: entry.action.kind,
        approved: entry.action.kind !== 'reject',
        message,
        values: formValues as Record<string, UserActionFormValue>,
      })
    },
    [activeInputKey, block.card.form?.fields, formValues, onActionComplete]
  )

  const isActionButtonDisabled = useCallback(
    (entry: UserActionEntry): boolean => {
      if (disabled || settled) return true
      if (entry.action.kind !== 'submit_form') return false
      return false
    },
    [disabled, settled]
  )

  return {
    card: block.card,
    isHidden: false,
    isConsumed: settled,
    isTimedOut: false,
    interactionDisabled: disabled,
    formFields: block.card.form?.fields ?? [],
    actionEntries,
    completedActionKey,
    pendingActionKey: null,
    settled,
    formValues,
    formErrors,
    inputValue,
    timeoutPaused,
    effectiveTimeoutMs: null,
    activeInputEntry,
    completedEntry:
      actionEntries.find((entry) => entry.key === completedActionKey) ?? null,
    shouldShowCardActions: true,
    shouldShowSkipButton: false,
    setInputValue,
    setTimeoutPaused,
    handleFormFieldChange,
    submitAction,
    skipCard: () => undefined,
    cancelInput: () => {
      setActiveInputKey(null)
      setInputValue('')
    },
    isInputSubmitDisabled: () => disabled || settled || inputValue.trim().length === 0,
    isActionButtonDisabled,
    isFormDisabled: disabled || settled,
    isInputPanelDisabled: disabled || settled,
  }
}

export function UserActionCard({
  block,
  disabled = false,
  onActionComplete,
  onDismiss,
  onOpenArtifact,
}: {
  block: UserActionBlock
  disabled?: boolean
  onActionComplete?: (resolution: UserActionResolution) => void | Promise<void>
  onDismiss?: () => void
  onOpenArtifact?: (path: string) => unknown
  sessionId: string
}): ReactElement | null {
  const view = usePreviewUserActionView({ block, disabled, onActionComplete })
  return (
    <UserActionCardContent
      view={view}
      disabled={disabled}
      onDismiss={onDismiss}
      onOpenArtifact={onOpenArtifact}
    />
  )
}

export function AskUserCarousel({
  block,
  disabled = false,
  onActionComplete,
  onDismiss,
}: {
  block: UserActionBlock
  disabled?: boolean
  onActionComplete?: (resolution: UserActionResolution) => void | Promise<void>
  onDismiss?: () => void
  sessionId: string
}): ReactElement | null {
  const view = usePreviewUserActionView({ block, disabled, onActionComplete })
  return <AskUserCarouselContent view={view} onDismiss={onDismiss} />
}
