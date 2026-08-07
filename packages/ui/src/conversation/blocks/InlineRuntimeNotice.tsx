import { memo, type ReactElement, useMemo, useState } from 'react'
import { SpinnerGapIcon } from '@phosphor-icons/react'
import { useInterval } from 'ahooks'

import { renderChatNoticeToneIcon, StyleUtils } from '@velaros-ai/ui'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n, useConversationTranslatorRuntime } from '../i18n'
import { useConversationRenderSlots } from '../render-slots'
import {
  type ChatInlineNoticeMeta,
  type ChatInlineNoticeRuntimeSource,
  getChatInlineNoticeMeta,
} from '../status/chatStatus'

import styles from './MessageBubble.module.css'

import { isPresent, optionalWhenLazy } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)

function InlineRuntimeNoticeInner({
  notice,
  runtimeSource = null,
  sessionId,
}: {
  notice: ChatInlineNoticeMeta
  runtimeSource?: LooseOptional<ChatInlineNoticeRuntimeSource>
  sessionId: string
}): ReactElement {
  const { locale } = useConversationI18n()
  const translatorRuntime = useConversationTranslatorRuntime()
  const slots = useConversationRenderSlots()
  const [clock, setClock] = useState(() => Date.now())
  const shouldRefreshRunningNotice =
    notice.tone === 'running' && runtimeSource?.runtime.status === 'running'

  useInterval(
    () => {
      setClock(Date.now())
    },
    optionalWhenLazy(shouldRefreshRunningNotice, () => 1000),
    { immediate: true }
  )

  const displayNotice = useMemo(() => {
    if (!shouldRefreshRunningNotice || !runtimeSource) return notice

    const options = isPresent(runtimeSource.liveTraceSummary)
      ? { liveTraceSummary: runtimeSource.liveTraceSummary, now: clock }
      : { now: clock }

    return (
      getChatInlineNoticeMeta(runtimeSource.runtime, locale, options, translatorRuntime) ?? notice
    )
  }, [clock, locale, notice, runtimeSource, shouldRefreshRunningNotice, translatorRuntime])

  // 运行态行首画的是**谁在跑**（执行体标记），由宿主经 `runningRuntimeMark` 槽给出：Velar 自己的
  // 会话画帆标，外接引擎会话画那家自己的品牌标。
  //
  // 上一版在这里写死旋转指示器，理由是「品牌帆标表达『Velar 在跑』，而引擎会话不是 Velar 在跑，
  // 同一个图标在两种执行体下都出现就是一句不成立的断言」——那个判据只否掉了**包内写死一个图形**，
  // 没否掉「按会话给不同图形」。执行体身份是宿主知识（绑定权威在分组注册表），所以正路是把这一格
  // 交出去，而不是退回一个对谁都不表态的转圈。宿主认不出这条会话归谁时槽回 `null`，仍回落转圈。
  const runningMark =
    displayNotice.tone === 'running' ? slots.runningRuntimeMark?.({ sessionId }) : null
  const noticeIcon =
    displayNotice.tone === 'running'
      ? (runningMark ?? (
          <SpinnerGapIcon className={styles.inlineNoticeRunningIcon} size={13} aria-hidden="true" />
        ))
      : renderChatNoticeToneIcon(displayNotice.tone, 12)

  return (
    <div
      className={cx(
        'inlineNotice',
        displayNotice.tone === 'running' && 'inlineNoticeRunning',
        displayNotice.tone === 'warning' && 'inlineNoticeWarning',
        displayNotice.tone === 'error' && 'inlineNoticeError'
      )}
      title={displayNotice.text}
    >
      {displayNotice.tone === 'running'
        ? noticeIcon
        : noticeIcon && <span className={styles.inlineNoticeIcon}>{noticeIcon}</span>}
      <Text className={styles.inlineNoticeText}>{displayNotice.text}</Text>
    </div>
  )
}

export const InlineRuntimeNotice = memo(InlineRuntimeNoticeInner)
InlineRuntimeNotice.displayName = 'InlineRuntimeNotice'
