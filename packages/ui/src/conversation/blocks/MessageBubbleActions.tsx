import { type ReactElement, useId, useState } from 'react'
import { ClockCounterClockwiseIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useLatest, useLockFn } from 'ahooks'

import { StyleUtils } from '@velaros-ai/ui'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton, type IconButtonPresetSize } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Radio, RadioGroup } from '@velaros-ai/ui/primitives/forms/RadioGroup'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'
import { CopyButton } from '@velaros-ai/ui/product/buttons/CopyButton'

import { useConversationI18n } from '../i18n'
import type { ConversationRewindPlan } from '../projection'
import { useChatToolRenderCapabilities } from '../tool-render/chatToolRenderCapabilitiesContext'

import {
  formatMessageDateTime,
  formatMessageTime,
} from './messageBubbleRenderModel'
import {
  type MessageClipboardContent,
  writeMessageClipboardContent,
} from './messageClipboard'
import {
  formatMessageCostEstimate,
  type MessageCostEstimate as MessageCostEstimateValue,
} from './messageCostEstimate'
import { formatExactNumber } from './numberFormat'

import styles from './MessageBubble.module.css'

import type { AppLocale } from '#contracts'
import { AppError } from '#internal/result'
import { isBlank, Log, toNullable } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)
const log = Log.tag('message-rewind')

const MESSAGE_ACTION_ICON_SIZE = 'icon-sm' satisfies IconButtonPresetSize

export function MessageCopyButton({
  content,
  label,
  copiedLabel,
}: {
  content: MessageClipboardContent
  label: string
  copiedLabel: string
}): Nullable<ReactElement> {
  if (isBlank(content.plainText) && content.assets.length === 0) return null

  return (
    <CopyButton
      value={content.plainText}
      label={label}
      copiedLabel={copiedLabel}
      size={MESSAGE_ACTION_ICON_SIZE}
      onCopy={() => writeMessageClipboardContent(content)}
    />
  )
}

/** 文件回退的二选一取值；只有 `plan.files.kind === 'restorable'` 时才会出现在界面上。 */
type RewindFileChoice = 'conversation-only' | 'restore-files'

/**
 * 回溯确认框。
 *
 * 分档只看宿主给的 `ConversationRewindPlan`，**不看空间**：
 * - 没有文件轴（系统 / 浏览器工作区）或这几轮压根没改过文件 → 纯确认框，一个字都不提文件；
 * - 改过文件但没有快照 → 确认框 + 一行如实说明「回不了」，不给假开关；
 * - 改过文件且有快照 → 二选一。用单选而不是复选框，是因为两个后果都是实质性的：
 *   复选框的「不勾」会被读成「默认什么都不会发生」，而实际默认是「文件停在未来」。
 */
export function MessageRewindButton({
  messageId,
  disabled = false,
  onRewind,
  getRewindPlan,
}: {
  messageId: string
  disabled?: boolean
  onRewind?: (messageId: string, options?: { restoreFiles?: boolean }) => Promise<void>
  /** 打开确认框那一刻由宿主同步算出的预览；返回 null 表示这条消息回溯不了。 */
  getRewindPlan?: (messageId: string) => Nullable<ConversationRewindPlan>
}): Nullable<ReactElement> {
  const { t } = useConversationI18n()
  const { showNotice } = useChatToolRenderCapabilities()
  const [plan, setPlan] = useState<Nullable<ConversationRewindPlan>>(null)
  const [isRewinding, setIsRewinding] = useState(false)
  const [fileChoice, setFileChoice] = useState<RewindFileChoice>('conversation-only')
  const onRewindLatest = useLatest(onRewind)
  const tLatest = useLatest(t)
  const showNoticeLatest = useLatest(showNotice)
  const canRestoreFiles = plan?.files.kind === 'restorable'

  const handleConfirm = useLockFn(async (): Promise<void> => {
    const rewind = onRewindLatest.current

    if (!rewind) return

    try {
      setIsRewinding(true)
      await rewind(messageId, {
        restoreFiles: canRestoreFiles && fileChoice === 'restore-files',
      })
      setPlan(null)
      showNoticeLatest.current?.({
        title: tLatest.current('chat.rewindSuccessTitle'),
        description: tLatest.current('chat.rewindSuccessDescription'),
        tone: 'success',
        duration: 2600,
      })
    } catch (error) {
      const appError = AppError.from(error)
      log.error('回溯消息失败', { code: appError.code, error: appError.message })
      showNoticeLatest.current?.({
        title: tLatest.current('chat.rewindErrorTitle'),
        description: appError.message.trim() || tLatest.current('chat.rewindErrorFallback'),
        tone: appError.code === 'VALIDATION' || appError.code === 'NOT_FOUND' ? 'warning' : 'error',
        showClose: true,
      })
    } finally {
      setIsRewinding(false)
    }
  })

  if (!onRewind) return null

  return (
    <>
      {/* 会话非 idle 时只收起入口图标，**不卸载弹窗**：已经打开的确认框不能凭空消失。 */}
      {!disabled && (
        <IconButton
          label={t('chat.rewindToBeforeMessage')}
          variant="ghost"
          size={MESSAGE_ACTION_ICON_SIZE}
          shape="round"
          className={styles.messageRewindButton}
          disabled={isRewinding}
          onClick={() => {
            setFileChoice('conversation-only')
            setPlan(toNullable(getRewindPlan?.(messageId)))
          }}
        >
          <ClockCounterClockwiseIcon size={14} />
        </IconButton>
      )}
      <Dialog
        open={!!plan}
        onOpenChange={(nextOpen) => {
          if (!isRewinding && !nextOpen) {
            setPlan(null)
            setFileChoice('conversation-only')
          }
        }}
      >
        <DialogContent
          className="velar-confirm-dialog"
          showClose={!isRewinding}
          onInteractOutside={(event) => {
            event.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('chat.rewindDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('chat.rewindDialogDescription', {
                turns: plan?.removedTurnCount ?? 0,
                messages: plan?.removedMessageCount ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          {!!plan && <RewindFilePlanSection
            plan={plan}
            choice={fileChoice}
            disabled={isRewinding || disabled}
            onChoiceChange={setFileChoice}
          />}
          {/* 弹窗开着时会话被推成运行中：留着窗口但禁用确认，并说明为什么点不动。 */}
          {disabled && !isRewinding && (
            <p className={styles.rewindFileNotice}>{t('chat.rewindWhileActive')}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={isRewinding}
              onClick={() => setPlan(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isRewinding || disabled}
              onClick={() => {
                void handleConfirm()
              }}
            >
              {isRewinding && (
                <SpinnerGapIcon size={14} className={styles.assistantMemorySpinIcon} />
              )}
              {isRewinding ? t('chat.rewindPendingAction') : t('chat.rewindConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function RewindFilePlanSection({
  plan,
  choice,
  disabled,
  onChoiceChange,
}: {
  plan: ConversationRewindPlan
  choice: RewindFileChoice
  disabled: boolean
  onChoiceChange: (next: RewindFileChoice) => void
}): Nullable<ReactElement> {
  const { t } = useConversationI18n()
  const groupId = useId()
  const files = plan.files

  if (files.kind === 'out-of-scope' || files.kind === 'nothing-to-restore') return null

  if (files.kind === 'no-snapshot')
    return (
      <p className={styles.rewindFileNotice}>
        {t('chat.rewindDialogNoSnapshot', { files: files.changedFileCount })}
      </p>
    )

  return (
    <RadioGroup
      className={styles.rewindFileChoiceGroup}
      value={choice}
      disabled={disabled}
      onValueChange={(next) => onChoiceChange(next as RewindFileChoice)}
    >
      <div className={styles.rewindFileChoiceRow}>
        <Radio
          id={`${groupId}-conversation-only`}
          size="sm"
          value={'conversation-only' satisfies RewindFileChoice}
        />
        {/* Radio 自身已经是一个 <label>，所以这里只能用 htmlFor 指过去，不能再套一层 label。
            点选项文字必须能切换：在一个不可撤销、会覆盖手改文件的确认框里，点了没反应会被读成
            「这个选项是坏的」，更糟的是用户以为已经选中而实际提交的仍是默认档。 */}
        <label
          htmlFor={`${groupId}-conversation-only`}
          className={styles.rewindFileChoiceText}
        >
          <span className={styles.rewindFileChoiceLabel}>{t('chat.rewindDialogKeepFiles')}</span>
          <span className={styles.rewindFileChoiceHint}>
            {t('chat.rewindDialogKeepFilesHint', { files: files.changedFileCount })}
          </span>
        </label>
      </div>
      <div className={styles.rewindFileChoiceRow}>
        <Radio
          id={`${groupId}-restore-files`}
          size="sm"
          value={'restore-files' satisfies RewindFileChoice}
        />
        <label htmlFor={`${groupId}-restore-files`} className={styles.rewindFileChoiceText}>
          <span className={styles.rewindFileChoiceLabel}>{t('chat.rewindDialogRestoreFiles')}</span>
          <span className={styles.rewindFileChoiceHint}>
            {t('chat.rewindDialogRestoreFilesHint', { roots: files.rootCount })}
          </span>
        </label>
      </div>
    </RadioGroup>
  )
}

export function MessageTimestamp({
  timestamp,
  locale,
  variant = 'default',
}: {
  timestamp: number
  locale: AppLocale
  /** 封闭外貌枚举，取代开放 className 逃生口（§12.9 形态封闭）。 */
  variant?: 'default' | 'user'
}): Nullable<ReactElement> {
  const date = new Date(timestamp)

  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) return null

  const label = formatMessageTime(timestamp, locale)
  const title = formatMessageDateTime(timestamp, locale)

  return (
    <time
      className={cx('messageTimestamp', variant === 'user' && 'userMessageTimestamp')}
      data-chat-virtual-measure-overflow="true"
      dateTime={date.toISOString()}
      title={title}
    >
      {label}
    </time>
  )
}

export function MessageCostEstimate({
  estimate,
  locale,
}: {
  estimate: Nullable<MessageCostEstimateValue>
  locale: AppLocale
}): Nullable<ReactElement> {
  if (!estimate) return null

  const label = formatMessageCostEstimate(locale, estimate.usd)
  const title = `${formatExactNumber(locale, estimate.inputTokens)} input tokens · ${formatExactNumber(locale, estimate.outputTokens)} output tokens`

  return (
    <span className={styles.messageCostEstimate} title={title}>
      {label}
    </span>
  )
}
