import { memo, type ReactElement, useMemo, useState } from 'react'
import { SpinnerGapIcon } from '@phosphor-icons/react'
import { useInterval } from 'ahooks'

import { renderChatNoticeToneIcon, StyleUtils } from '@velaros-ai/ui'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n, useConversationTranslatorRuntime } from '../i18n'
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
}: {
  notice: ChatInlineNoticeMeta
  runtimeSource?: LooseOptional<ChatInlineNoticeRuntimeSource>
}): ReactElement {
  const { locale } = useConversationI18n()
  const translatorRuntime = useConversationTranslatorRuntime()
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

  // 运行态图标 = 旋转指示器，**不是**品牌帆标（判决，别改回去）。
  // 判据两条：① 这一行的文案是「思考中 · N 轮 · N 秒」，一个**进度**指示；帆标在 12px 下读不出
  // 「帆」，只看得出一个像船锚/旗子的形状，与「正在跑」无语义关系。② 品牌标记表达的是
  // 「Velar 在跑」，而外部 agent 引擎会话根本不是 Velar 在跑——同一个图标在两种执行体下
  // 都出现，就变成了一句不成立的断言。旋转指示器对两者都正确，因此不需要按会话注入不同图标。
  const noticeIcon =
    displayNotice.tone === 'running' ? (
      <SpinnerGapIcon className={styles.inlineNoticeRunningIcon} size={13} aria-hidden="true" />
    ) : (
      renderChatNoticeToneIcon(displayNotice.tone, 12)
    )

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
