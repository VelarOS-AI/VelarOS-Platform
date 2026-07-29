import { memo, type ReactElement } from 'react'
import {
  CaretLeftIcon,
  CaretRightIcon,
  ChatCircleIcon,
  CheckIcon,
  SpinnerGapIcon,
  WrenchIcon,
  XIcon,
} from '@phosphor-icons/react'

import { InteractionSuggestionCard } from '@velaros-ai/ui'
import { Textarea } from '@velaros-ai/ui/primitives/forms/Textarea'
import { ActionCardIconButton } from '@velaros-ai/ui/product/layout/ActionCard'

import { useSuggestionCardRejection } from '../cards/useSuggestionCardRejection'
import { useConversationI18n } from '../i18n'
import type { SystemToolInstallSuggestionView } from '../projection'

import styles from './MessageBubble.module.css'

import type { ContentBlock } from '#contracts'

const InsertDraftEventName = 'velaros:insert-chat-draft'

function SystemToolInstallSuggestionCardInner({
  block,
  view: installAction,
}: {
  block: Extract<ContentBlock, { type: 'system-tool-install-suggestion' }>
  /** 宿主 hook `useSystemToolInstallSuggestionViewModel` 的输出投影（安装动作注入进来）。 */
  view: SystemToolInstallSuggestionView
}): ReactElement {
  const { locale, t } = useConversationI18n()
  const { isRejecting, rejectionText, setRejectionText, beginReject, cancelReject } =
    useSuggestionCardRejection()
  const suggestion = block.suggestion
  const onlineAlternative = suggestion.alternatives?.find(
    (alternative) => alternative.id === 'browser-online'
  )
  const getLocalizedText = (text: { 'zh-CN': string; 'en-US': string }): string =>
    text[locale] ?? text['zh-CN'] ?? text['en-US']

  const buttonLabel =
    installAction.status === 'installing'
      ? t('systemToolInstall.installing')
      : installAction.status === 'installed'
        ? t('systemToolInstall.installed')
        : t('systemToolInstall.install')
  const title = t('systemToolInstall.suggestionTitle', { label: suggestion.label })
  const description =
    installAction.status === 'installed'
      ? t('systemToolInstall.installedSummary', { label: suggestion.label })
      : installAction.status === 'failed'
        ? t('systemToolInstall.commandStillMissingDescription', { label: suggestion.label })
        : t('systemToolInstall.compactSuggestionDescription', { command: suggestion.command })
  const detailSuffix =
    suggestion.installCommand ?? (onlineAlternative ? getLocalizedText(onlineAlternative.description) : '')
  const detail = detailSuffix ? `${description} · ${detailSuffix}` : description
  const tone =
    installAction.status === 'installed'
      ? 'success'
      : installAction.status === 'failed'
        ? 'error'
        : 'warning'
  const buildRejectDraft = (): string => {
    const trimmed = rejectionText.trim()
    if (trimmed) return t('systemToolInstall.rejectDraftWithReason', {
        label: suggestion.label,
        reason: trimmed,
      })

    return t('systemToolInstall.rejectDraftFallback', { label: suggestion.label })
  }
  const handleTellModel = (): void => {
    window.dispatchEvent(
      new CustomEvent(InsertDraftEventName, {
        detail: {
          text: buildRejectDraft(),
        },
      })
    )
  }
  const handleUseAlternative = (): void => {
    if (!onlineAlternative) return

    window.dispatchEvent(
      new CustomEvent(InsertDraftEventName, {
        detail: {
          text: getLocalizedText(onlineAlternative.draft),
        },
      })
    )
  }

  const actions = isRejecting ? (
    <>
      <ActionCardIconButton
        label={t('confirmation.back')}
        onClick={cancelReject}
      >
        <CaretLeftIcon size={15} />
      </ActionCardIconButton>
      <ActionCardIconButton label={t('systemToolInstall.tellModel')} onClick={handleTellModel}>
        <ChatCircleIcon size={15} />
      </ActionCardIconButton>
    </>
  ) : (
    <>
      <ActionCardIconButton
        label={buttonLabel}
        disabled={
          !installAction.canInstall ||
          installAction.status === 'installing' ||
          installAction.status === 'installed'
        }
        onClick={installAction.install}
      >
        {installAction.status === 'installing' ? (
          <SpinnerGapIcon size={15} />
        ) : (
          <WrenchIcon size={15} />
        )}
      </ActionCardIconButton>
      {!!onlineAlternative && (
        <ActionCardIconButton
          label={getLocalizedText(onlineAlternative.label)}
          onClick={handleUseAlternative}
        >
          <CaretRightIcon size={15} />
        </ActionCardIconButton>
      )}
      {(installAction.status !== 'installed') && (
        <ActionCardIconButton
          label={t('systemToolInstall.doNotInstall')}
          onClick={beginReject}
        >
          <XIcon size={15} weight="bold" />
        </ActionCardIconButton>
      )}
    </>
  )

  return (
    <InteractionSuggestionCard
      tone={tone}
      icon={
        installAction.status === 'installed' ? (
          <CheckIcon size={17} weight="bold" />
        ) : installAction.status === 'failed' ? (
          <XIcon size={17} weight="bold" />
        ) : (
          <WrenchIcon size={17} weight="duotone" />
        )
      }
      title={title}
      description={detail}
      actions={actions}
    >
      {isRejecting && (
        <div className={styles.systemToolSuggestionRejectPanel}>
          <Textarea
            size="sm"
            className={styles.systemToolSuggestionRejectTextarea}
            value={rejectionText}
            aria-label={t('confirmation.optionalNote')}
            placeholder={t('systemToolInstall.suggestionRejectionPlaceholder')}
            onChange={(event) => setRejectionText(event.currentTarget.value)}
            autoFocus
          />
        </div>
      )}
    </InteractionSuggestionCard>
  )
}

export const SystemToolInstallSuggestionCard = memo(SystemToolInstallSuggestionCardInner)
SystemToolInstallSuggestionCard.displayName = 'SystemToolInstallSuggestionCard'
