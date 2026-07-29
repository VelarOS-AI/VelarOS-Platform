import { memo, type ReactElement, useMemo } from 'react'
import { WrenchIcon } from '@phosphor-icons/react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Label } from '@velaros-ai/ui/primitives/display/Label'
import { Textarea } from '@velaros-ai/ui/primitives/forms/Textarea'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { ActionCard } from '@velaros-ai/ui/product/layout/ActionCard'

import type { ConversationMessageKey } from '../i18n'
import { useConversationI18n } from '../i18n'

import { useSuggestionCardRejection } from './useSuggestionCardRejection'

import styles from './ChatConfirmationCard.module.css'

import { isBlank, isEmpty, toNullable } from '#internal/runtime'

type Translate = (key: ConversationMessageKey, params?: Record<string, string | number>) => string

interface ChatConfirmationCardProps {
  message: Nullable<string>
  onApprove: () => void
  onReject: (rejectionMessage?: LooseOptional<string>) => void
}

interface InstallConfirmationDetail {
  reason: Nullable<string>
  installCommand: Nullable<string>
}

function getMessageLines(message: Nullable<string>): string[] {
  const lines: string[] = []

  for (const line of (message ?? '').split('\n')) {
    const trimmedLine = line.trim()
    if (!isEmpty(trimmedLine)) lines.push(trimmedLine)
  }

  return lines
}

function readPrefixedLine(lines: string[], prefix: string): Nullable<string> {
  const line = lines.find((candidate) => candidate.startsWith(prefix))
  const value = line?.slice(prefix.length).trim()
  return value && !isBlank(value) ? value : null
}

function parseInstallConfirmationMessage(
  message: Nullable<string>
): Nullable<InstallConfirmationDetail> {
  const lines = getMessageLines(message)
  const title = lines.find((line) => !isBlank(line))

  if (title !== '系统工具安装申请') return null

  const installLabelIndex = lines.findIndex((line) => line === '安装命令：')
  const installCommand = installLabelIndex >= 0 ? toNullable(lines[installLabelIndex + 1]) : null

  return {
    reason: readPrefixedLine(lines, '用途：'),
    installCommand,
  }
}

function joinConfirmationDescriptionParts(
  separator: string,
  parts: ReadonlyArray<LooseOptional<string>>
): string {
  let description = ''

  for (const part of parts) {
    if (!part) continue

    description = description ? `${description}${separator}${part}` : part
  }

  return description
}

function formatConfirmationDescription({
  message,
  fallback,
  t,
}: {
  message: Nullable<string>
  fallback: string
  t: Translate
}): string {
  const lines = getMessageLines(message)

  if (isEmpty(lines)) return fallback

  if (lines[0] === '模型请求加载按需能力。') {
    const plugin = readPrefixedLine(lines, '插件：')
    const category = readPrefixedLine(lines, '工具分类：')
    const reason = readPrefixedLine(lines, '原因：')
    const capability = plugin && category ? `${plugin} (${category})` : (plugin ?? category)
    const request = capability
      ? t('confirmation.capabilityRequestWithCapability', { capability })
      : t('confirmation.capabilityRequest')

    return joinConfirmationDescriptionParts(t('confirmation.descriptionSeparator'), [
      request,
      reason ? t('confirmation.capabilityReason', { reason }) : null,
    ])
  }

  if (lines[0] === '工作区授权请求') {
    const type = readPrefixedLine(lines, '类型：')
    const root = readPrefixedLine(lines, '目标工作区：')
    const operation = readPrefixedLine(lines, '操作：')
    const request = type
      ? t('confirmation.workspaceRequestWithType', { type })
      : t('confirmation.workspaceRequest')

    return joinConfirmationDescriptionParts(t('confirmation.descriptionSeparator'), [
      request,
      root ? t('confirmation.workspaceTarget', { root }) : null,
      operation ? t('confirmation.workspaceOperation', { operation }) : null,
    ])
  }

  return lines.join(' ')
}

function ChatConfirmationCardInner({
  message,
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
  const installDetail = useMemo(() => parseInstallConfirmationMessage(message), [message])
  const isInstallRequest = !!installDetail
  const confirmationDescription = useMemo(
    () =>
      formatConfirmationDescription({
        message,
        fallback: t('status.awaitingConfirmationDescription'),
        t,
      }),
    [message, t]
  )

  if (isInstallRequest && installDetail) {
    const installExplanation = installDetail.reason
    const installTitle = (
      <div className={styles.installTitleLine}>
        <span>{t('systemToolInstall.requestTitle')}</span>
        {!!installDetail.installCommand && (
          <code className={styles.installCommand}>{installDetail.installCommand}</code>
        )}
      </div>
    )

    return (
      <ActionCard
        className={styles.installRoot}
        icon={<WrenchIcon size={18} weight="duotone" />}
        iconClassName={styles.installIcon}
        title={installTitle}
        actionsClassName={styles.actions}
        actions={
          isRejecting ? (
            <>
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
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" className={styles.reject} onClick={beginReject}>
                {t('common.reject')}
              </Button>
              <Button size="sm" variant="outline" className={styles.approve} onClick={onApprove}>
                {t('common.approve')}
              </Button>
            </>
          )
        }
        role="group"
        aria-label={t('systemToolInstall.requestTitle')}
      >
        {isRejecting ? (
          <div className={styles.rejectPanel}>
            <Label className={styles.rejectLabel} htmlFor="install-rejection-message">
              {t('confirmation.optionalNote')}
            </Label>
            <Textarea
              id="install-rejection-message"
              size="sm"
              className={styles.rejectTextarea}
              value={rejectionMessage}
              placeholder={t('systemToolInstall.installRejectionPlaceholder')}
              onChange={(event) => setRejectionMessage(event.currentTarget.value)}
              autoFocus
            />
          </div>
        ) : (
          <div className={styles.installDetailRow}>
            {!!installExplanation && (
              <div className={styles.installExplanation}>{installExplanation}</div>
            )}
          </div>
        )}
      </ActionCard>
    )
  }

  return (
    <div className={styles.root} role="group" aria-label={t('status.awaitingConfirmation')}>
      <div className={styles.body}>
        <div className={styles.title}>{t('status.awaitingConfirmation')}</div>
        <div className={styles.description} title={confirmationDescription}>
          {confirmationDescription}
        </div>
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
