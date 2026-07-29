import { memo, type ReactElement, useMemo, useState } from 'react'
import { useInterval } from 'ahooks'

import { renderChatNoticeToneIcon, StyleUtils } from '@velaros-ai/ui'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n, useConversationTranslatorRuntime } from '../i18n'
import {
  type ChatInlineNoticeMeta,
  type ChatInlineNoticeRuntimeSource,
  getChatInlineNoticeMeta,
} from '../status/chatStatus'

import { VelarSailMark } from './VelarSailMark'

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

  const noticeIcon =
    displayNotice.tone === 'running' ? (
      <VelarSailMark
        className={styles.inlineNoticeSailIcon}
        size="tiny"
        motion="steady"
        showWindLines={false}
      />
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
