import { memo, type ReactElement } from 'react'
import {
  CheckCircleIcon,
  PauseCircleIcon,
  StopCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { BubbleTooltip } from '@velaros-ai/ui/primitives/overlays/Tooltip'

import { useConversationI18n } from '../i18n'
import type { ConversationRunMarkerView } from '../projection'

import styles from './MessageBubble.module.css'

const cx = StyleUtils.bindCx(styles)

function getRunMarkerMeta(
  marker: ConversationRunMarkerView,
  t: ReturnType<typeof useConversationI18n>['t']
): {
  label: string
  turnLabel: Nullable<string>
  detail: Nullable<string>
  toneClass: 'statusSuccess' | 'statusWarning' | 'statusError'
  icon: ReactElement
} {
  const turnLabel =
    marker.turnCount && marker.turnKind
      ? marker.turnKind === 'turn'
        ? t('status.turn', { count: marker.turnCount })
        : t('status.totalTurns', { count: marker.turnCount })
      : null

  switch (marker.status) {
    case 'completed':
      return {
        label: t('status.completed'),
        turnLabel,
        detail: null,
        toneClass: 'statusSuccess',
        icon: <CheckCircleIcon size={14} weight="fill" />,
      }
    case 'failed':
      return {
        label: t('status.failed'),
        turnLabel,
        detail: marker.detail ?? t('status.seeErrorInContent'),
        toneClass: 'statusError',
        icon: <XCircleIcon size={14} weight="fill" />,
      }
    case 'aborted':
      return {
        label: t('status.aborted'),
        turnLabel,
        detail: marker.detail ?? t('status.runAbortedDescription'),
        toneClass: 'statusWarning',
        icon: <StopCircleIcon size={14} weight="fill" />,
      }
    case 'awaiting-confirmation':
      return {
        label: t('status.awaitingConfirmation'),
        turnLabel,
        detail: marker.detail ?? t('status.awaitingConfirmationDescription'),
        toneClass: 'statusWarning',
        icon: <PauseCircleIcon size={14} weight="fill" />,
      }
    case 'awaiting-input':
      return {
        label: t('status.awaitingInput'),
        turnLabel,
        detail: marker.detail ?? t('status.awaitingInputDescription'),
        toneClass: 'statusWarning',
        icon: <PauseCircleIcon size={14} weight="fill" />,
      }
  }
}

function MessageStatusMarkerInner({ marker }: { marker: ConversationRunMarkerView }): ReactElement {
  const { t } = useConversationI18n()
  const meta = getRunMarkerMeta(marker, t)
  const tooltip = meta.turnLabel ? `${meta.label}\n${meta.turnLabel}` : meta.label

  return (
    <BubbleTooltip
      side="top"
      align="center"
      sideOffset={6}
      delayDuration={80}
      disableHoverableContent
      ariaLabel={tooltip}
      content={
        <div className={styles.statusMarkerTooltip}>
          <div className={styles.statusMarkerTooltipTitle}>{meta.label}</div>
          {!!meta.turnLabel && (
            <>
              <span className={styles.statusMarkerTooltipSeparator} aria-hidden="true" />
              <div className={styles.statusMarkerTooltipMeta}>{meta.turnLabel}</div>
            </>
          )}
        </div>
      }
    >
      <span className={cx('statusMarker', meta.toneClass)} aria-label={tooltip}>
        {meta.icon}
      </span>
    </BubbleTooltip>
  )
}

export const MessageStatusMarker = memo(MessageStatusMarkerInner)
MessageStatusMarker.displayName = 'MessageStatusMarker'
