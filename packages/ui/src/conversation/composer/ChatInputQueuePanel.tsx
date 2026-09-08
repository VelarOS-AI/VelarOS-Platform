import React, { memo, useState } from 'react'
import {
  ArrowUpIcon,
  DotsSixVerticalIcon,
  PencilSimpleIcon,
  PlayIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { StyleUtils } from '@velaros-ai/ui'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'

import { useConversationI18n } from '../i18n'

import {
  type QueuedDraftDropPlacement,
  resolveQueuedDraftDragMoves,
} from './utils/chatInputQueueReorder.utils'
import type { ChatInputQueuedDraft } from './chatInputTypes'

import styles from './ChatInput.module.css'

import { isBlank, isEmpty,toNullable } from '#internal/runtime'

export interface ChatInputQueuePanelProps {
  errorMessage?: LooseOptional<string>
  isPaused?: boolean
  onResume?: () => void | Promise<void>
  queuedDrafts: ChatInputQueuedDraft[]
  drainingId?: LooseOptional<string>
  isQueueDraining: boolean
  isStreaming: boolean
  onQueuedDraftMove?: (id: string, direction: 'up' | 'down') => void
  onQueuedDraftRemove?: (id: string) => void
  onQueuedDraftGuide?: (id: string) => void | Promise<void>
  onQueuedDraftReturnToInput?: (id: string) => void
  onQueuedDraftRunNow?: (id: string) => void | Promise<void>
}

const cx = StyleUtils.bindCx(styles)
const QueuedDraftDragMimeType = 'application/x-velaros-queued-draft'

export const ChatInputQueuePanel = memo(function ChatInputQueuePanel({
  errorMessage,
  isPaused = false,
  onResume,
  queuedDrafts,
  isQueueDraining,
  drainingId,
  isStreaming,
  onQueuedDraftMove,
  onQueuedDraftRemove,
  onQueuedDraftGuide,
  onQueuedDraftReturnToInput,
  onQueuedDraftRunNow,
}: ChatInputQueuePanelProps): Nullable<ReactElement> {
  const { t } = useConversationI18n()
  const [draggedQueuedDraftId, setDraggedQueuedDraftId] = useState<Nullable<string>>(null)
  const [dragOverQueuedDraft, setDragOverQueuedDraft] =
    useState<Nullable<{ id: string; placement: QueuedDraftDropPlacement }>>(null)

  const hasQueuedDraftActions =
    !!onQueuedDraftMove ||
    !!onQueuedDraftRemove ||
    !!onQueuedDraftGuide ||
    !!onQueuedDraftRunNow ||
    !!onQueuedDraftReturnToInput

  function clearQueuedDraftDragState(): void {
    setDraggedQueuedDraftId(null)
    setDragOverQueuedDraft(null)
  }

  function resolveDropPlacement(event: React.DragEvent<HTMLElement>): QueuedDraftDropPlacement {
    const bounds = event.currentTarget.getBoundingClientRect()
    return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
  }

  function handleQueuedDraftDrop(event: React.DragEvent<HTMLDivElement>, targetId: string): void {
    if (!onQueuedDraftMove) return

    event.preventDefault()
    const draggedId =
      draggedQueuedDraftId || toNullable(event.dataTransfer.getData(QueuedDraftDragMimeType))
    if (!draggedId) {
      clearQueuedDraftDragState()
      return
    }

    const queuedDraftIds: string[] = []
    for (const queuedDraft of queuedDrafts) {
      queuedDraftIds.push(queuedDraft.id)
    }
    const placement = resolveDropPlacement(event)
    const moves = resolveQueuedDraftDragMoves(queuedDraftIds, draggedId, targetId, placement)
    for (const move of moves) {
      onQueuedDraftMove(move.id, move.direction)
    }
    clearQueuedDraftDragState()
  }

  function formatQueuedDraftText(item: ChatInputQueuedDraft): string {
    const text = item.value.trim()

    if (!isBlank(text)) return text

    const firstVirtualPasteReference = item.virtualPasteReferences?.[0]
    if (firstVirtualPasteReference)
      return `${firstVirtualPasteReference.id}: ${firstVirtualPasteReference.title}`

    if (!isEmpty(item.files)) {
      let fileSummary = ''
      for (const file of item.files) {
        fileSummary = fileSummary ? `${fileSummary}, ${file.name}` : file.name
      }

      return fileSummary
    }

    return t('chat.composerQueueEmptyDraft')
  }

  if (!queuedDrafts.length) return null

  return (
    <div className={styles.queuePanel}>
      {errorMessage && <Paragraph spacing="none" role="alert">{errorMessage}</Paragraph>}
      {isPaused && (
        <div className={styles.queueItem} role="status">
          <Paragraph spacing="none" className={styles.queueText}>{t('chat.queuedInputsPaused')}</Paragraph>
          {onResume && (
            <IconButton
              size="icon-sm"
              label={t('chat.resumeQueuedInputs')}
              title={t('chat.resumeQueuedInputs')}
              disabled={isQueueDraining || isStreaming}
              onClick={() => { void onResume() }}
            >
              <PlayIcon size={14} />
            </IconButton>
          )}
        </div>
      )}
      <div className={styles.queueList}>
        {queuedDrafts.map((item, index) => {
          const isFirst = index === 0
          const isItemDraining = isQueueDraining && (drainingId ? item.id === drainingId : isFirst)
          const displayText = formatQueuedDraftText(item)
          const isItemDragging = draggedQueuedDraftId === item.id
          const dropPlacement =
            dragOverQueuedDraft?.id === item.id && draggedQueuedDraftId !== item.id
              ? dragOverQueuedDraft.placement
              : null

          return (
            <div
              key={item.id}
              className={styles.queueItem}
              data-draining={isItemDraining}
              data-dragging={isItemDragging}
              data-drop-edge={dropPlacement || undefined}
              onDragOver={(event) => {
                if (!onQueuedDraftMove || !draggedQueuedDraftId) return

                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDragOverQueuedDraft({
                  id: item.id,
                  placement: resolveDropPlacement(event),
                })
              }}
              onDragLeave={(event) => {
                const relatedTarget = event.relatedTarget
                if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget))
                  return

                setDragOverQueuedDraft((current) => (current?.id === item.id ? null : current))
              }}
              onDrop={(event) => handleQueuedDraftDrop(event, item.id)}
            >
              {onQueuedDraftMove && (
                <button
                  type="button"
                  className={styles.queueDragHandle}
                  title={t('chat.composerQueueDragToMove')}
                  aria-label={t('chat.composerQueueDragToMove')}
                  draggable={!isQueueDraining && queuedDrafts.length > 1}
                  disabled={isQueueDraining || queuedDrafts.length < 2}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData(QueuedDraftDragMimeType, item.id)
                    setDraggedQueuedDraftId(item.id)
                    setDragOverQueuedDraft(null)
                  }}
                  onDragEnd={clearQueuedDraftDragState}
                >
                  <DotsSixVerticalIcon size={14} weight="bold" />
                </button>
              )}

              <div className={styles.queueItemMain}>
                <Paragraph spacing="none" className={styles.queueText} title={displayText}>
                  {displayText}
                </Paragraph>
              </div>

              {hasQueuedDraftActions && (
                <div className={styles.queueActions}>
                  {onQueuedDraftRunNow && !isStreaming && (
                    <IconButton
                      size="icon-sm"
                      label={t('chat.runQueuedInput')}
                      title={t('chat.runQueuedInput')}
                      disabled={isQueueDraining}
                      onClick={() => { void onQueuedDraftRunNow(item.id) }}
                    >
                      <PlayIcon size={13} />
                    </IconButton>
                  )}
                  {onQueuedDraftGuide && isStreaming && (
                    <IconButton
                      size="icon-sm"
                      className={styles.queueSendButton}
                      title={t('chat.composerQueueGuideNow')}
                      label={t('chat.composerQueueGuideNow')}
                      disabled={isQueueDraining}
                      onClick={() => {
                        void onQueuedDraftGuide(item.id)
                      }}
                    >
                      <ArrowUpIcon size={13} weight="bold" />
                    </IconButton>
                  )}
                  {onQueuedDraftReturnToInput && (
                    <IconButton
                      size="icon-sm"
                      className={styles.queueActionButton}
                      title={t('chat.composerQueueEdit')}
                      label={t('chat.composerQueueEdit')}
                      disabled={isQueueDraining}
                      onClick={() => onQueuedDraftReturnToInput(item.id)}
                    >
                      <PencilSimpleIcon size={13} />
                    </IconButton>
                  )}
                  {onQueuedDraftRemove && (
                    <IconButton
                      size="icon-sm"
                      className={cx('queueActionButton', 'queueActionDanger')}
                      title={t('chat.composerQueueRemove')}
                      label={t('chat.composerQueueRemove')}
                      disabled={isQueueDraining}
                      onClick={() => onQueuedDraftRemove(item.id)}
                    >
                      <TrashIcon size={13} />
                    </IconButton>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})

ChatInputQueuePanel.displayName = 'ChatInputQueuePanel'
