import { type KeyboardEvent, memo, type ReactElement, useEffect, useRef, useState } from 'react'
import { SpinnerGapIcon } from '@phosphor-icons/react'
import { useLatest } from 'ahooks'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Textarea } from '@velaros-ai/ui/primitives/forms/Textarea'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

import {
  ChatComposerInputMaxChars,
  ChatComposerInputWarningChars,
  clampChatComposerInput,
} from '../composer/utils/chatComposerLimits'
import { useConversationI18n } from '../i18n'

import { useAutoFocus } from './useAutoFocus'
import { useAutoResize } from './useAutoResize'

import styles from './ChatAwaitingInputCard.module.css'

import { isBlank, optionalWhenLazy } from '#internal/runtime'

interface ChatAwaitingInputCardProps {
  question: Nullable<string>
  onSubmit: (answer: string) => void | Promise<void>
}

const AWAITING_INPUT_MAX_HEIGHT = 112

function ChatAwaitingInputCardInner({
  question,
  onSubmit,
}: ChatAwaitingInputCardProps): ReactElement {
  const { t } = useConversationI18n()
  const onSubmitLatest = useLatest(onSubmit)
  const [answer, setAnswer] = useState('')
  const [limitError, setLimitError] = useState<Nullable<string>>(null)
  const [submitting, setSubmitting] = useState(false)
  const isComposingRef = useRef(false)
  const textareaRef = useAutoResize(answer, { maxHeight: AWAITING_INPUT_MAX_HEIGHT })
  const detail = question?.trim() || t('status.awaitingInputDescription')
  const hasAnswer = !isBlank(answer.trim())
  const canSubmit = !submitting && hasAnswer
  const canContinue = !submitting && !hasAnswer
  const inputLimitHelp =
    answer.length >= ChatComposerInputWarningChars
      ? t('chat.composerInputLimitCounter', {
          count: answer.length,
          max: ChatComposerInputMaxChars,
        })
      : null
  const visibleLimitMessage = limitError ?? inputLimitHelp

  useAutoFocus(textareaRef)

  useEffect(() => {
    setAnswer('')
    setLimitError(null)
  }, [question])

  function updateAnswer(nextAnswer: string): void {
    const limitedAnswer = clampChatComposerInput(nextAnswer)

    if (limitedAnswer.truncated) {
      setLimitError(t('chat.composerInputLimitReached', { max: ChatComposerInputMaxChars }))
    } else if (limitError) {
      setLimitError(null)
    }

    setAnswer(limitedAnswer.value)
  }

  async function submitAnswer(): Promise<void> {
    if (!canSubmit) return

    setSubmitting(true)
    try {
      await onSubmitLatest.current(answer)
    } finally {
      setSubmitting(false)
    }
  }

  async function continueExecution(): Promise<void> {
    if (!canContinue) return

    setSubmitting(true)
    try {
      await onSubmitLatest.current(t('status.awaitingInputContinueAnswer'))
    } finally {
      setSubmitting(false)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (isComposingRef.current) return

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitAnswer()
    }
  }

  return (
    <div className={styles.root} role="group" aria-label={t('status.awaitingInput')}>
      <div className={styles.column}>
        <div className={styles.topRow}>
          <div className={styles.body}>
            <div className={styles.title}>{t('status.awaitingInputTitle')}</div>
            <div className={styles.description} title={detail}>
              {detail}
            </div>
          </div>
          <Inline className={styles.actions} gap="xs" justify="end" wrap="wrap">
            <Button
              size="sm"
              variant="ghost"
              className={styles.continueText}
              disabled={!canContinue}
              onClick={() => {
                void continueExecution()
              }}
            >
              {!!(submitting && !hasAnswer) && (
                <SpinnerGapIcon size={15} className={styles.spinIcon} />
              )}
              <Text>{t('status.awaitingInputContinue')}</Text>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={styles.sendText}
              disabled={!canSubmit}
              onClick={() => {
                void submitAnswer()
              }}
            >
              {!!(submitting && hasAnswer) && (
                <SpinnerGapIcon size={15} className={styles.spinIcon} />
              )}
              <Text>
                {submitting ? t('status.awaitingInputSubmitting') : t('status.awaitingInputSubmit')}
              </Text>
            </Button>
          </Inline>
        </div>
        <Textarea
          ref={textareaRef}
          value={answer}
          maxLength={ChatComposerInputMaxChars}
          rows={1}
          size="sm"
          variant="bare"
          className={styles.textarea}
          placeholder={t('status.awaitingInputPlaceholder')}
          disabled={submitting}
          onChange={(event) => updateAnswer(event.currentTarget.value)}
          onPaste={(event) => {
            const pastedText = event.clipboardData.getData('text/plain')
            if (!pastedText) return

            const selectionStart = event.currentTarget.selectionStart ?? answer.length
            const selectionEnd = event.currentTarget.selectionEnd ?? answer.length
            const nextAnswer = `${answer.slice(0, selectionStart)}${pastedText}${answer.slice(selectionEnd)}`
            if (nextAnswer.length <= ChatComposerInputMaxChars) return

            event.preventDefault()
            updateAnswer(nextAnswer)
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            isComposingRef.current = true
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false
          }}
        />
        {!!visibleLimitMessage && (
          <Text
            className={limitError ? styles.limitMessageError : styles.limitMessage}
            role={optionalWhenLazy(limitError, () => 'alert')}
          >
            {visibleLimitMessage}
          </Text>
        )}
      </div>
    </div>
  )
}

export const ChatAwaitingInputCard = memo(ChatAwaitingInputCardInner)
ChatAwaitingInputCard.displayName = 'ChatAwaitingInputCard'
