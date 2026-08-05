import { memo, type ReactElement, useMemo } from 'react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Label } from '@velaros-ai/ui/primitives/display/Label'
import { Textarea } from '@velaros-ai/ui/primitives/forms/Textarea'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

import { useConversationI18n } from '../i18n'

import { buildConfirmationPresentation } from './chatConfirmationPresentation'
import { useSuggestionCardRejection } from './useSuggestionCardRejection'

import styles from './ChatConfirmationCard.module.css'

import type { ConfirmationRequestDetail } from '#contracts'
import { isEmpty, toNullable } from '#internal/runtime'

/**
 * 等待确认卡。
 *
 * 标题/正文/要点由 {@link buildConfirmationPresentation} 按上游信封的 `kind` 决定，`message` 只是
 * 兜底散文（见该模块的判决说明）。本文件只管布局与拒绝面板。
 */

interface ChatConfirmationCardProps {
  message: Nullable<string>
  /** 结构化信封；缺席时按 `message` 散文渲染。 */
  detail?: LooseOptional<ConfirmationRequestDetail>
  onApprove: () => void
  onReject: (rejectionMessage?: LooseOptional<string>) => void
}

function ChatConfirmationCardInner({
  message,
  detail,
  onApprove,
  onReject,
}: ChatConfirmationCardProps): ReactElement {
  const { t } = useConversationI18n()
  const {
    isRejecting,
    rejectionText: rejectionMessage,
    setRejectionText: setRejectionMessage,
    beginReject,
    cancelReject,
  } = useSuggestionCardRejection()
  const presentation = useMemo(
    () => buildConfirmationPresentation({ message, detail: toNullable(detail), t }),
    [detail, message, t]
  )

  return (
    <div className={styles.root} role="group" aria-label={presentation.title}>
      <div className={styles.body}>
        <div className={styles.title}>{presentation.title}</div>
        <div className={styles.description} title={presentation.description}>
          {presentation.description}
        </div>
        {!isEmpty(presentation.facts) && (
          <ul className={styles.facts}>
            {presentation.facts.map((fact) => (
              <li key={fact} className={styles.fact}>
                {fact}
              </li>
            ))}
          </ul>
        )}
        {isRejecting && (
          <div className={styles.rejectPanel}>
            <Label className={styles.rejectLabel} htmlFor="confirmation-rejection-message">
              {t('confirmation.optionalNote')}
            </Label>
            <Textarea
              id="confirmation-rejection-message"
              size="sm"
              className={styles.rejectTextarea}
              value={rejectionMessage}
              placeholder={t('confirmation.genericRejectionPlaceholder')}
              onChange={(event) => setRejectionMessage(event.currentTarget.value)}
              autoFocus
            />
            <Inline className={styles.actions} gap="sm" justify="end">
              <Button size="sm" variant="ghost" onClick={cancelReject}>
                {t('confirmation.back')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className={styles.reject}
                onClick={() => onReject(rejectionMessage)}
              >
                {t('confirmation.confirmRejection')}
              </Button>
            </Inline>
          </div>
        )}
      </div>
      {!isRejecting && (
        <Inline className={styles.actions} gap="xs" justify="end">
          <Button
            size="sm"
            variant="ghost"
            hoverBackground={false}
            className={styles.reject}
            onClick={beginReject}
          >
            {t('common.reject')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            hoverBackground={false}
            className={styles.approve}
            onClick={onApprove}
          >
            {t('common.approve')}
          </Button>
        </Inline>
      )}
    </div>
  )
}

export const ChatConfirmationCard = memo(ChatConfirmationCardInner)
ChatConfirmationCard.displayName = 'ChatConfirmationCard'
