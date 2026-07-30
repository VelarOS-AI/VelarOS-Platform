import React, { memo, useMemo } from 'react'
import { GlobeIcon, MagnifyingGlassIcon, SpinnerGapIcon } from '@phosphor-icons/react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n } from '../../../i18n'
import {
  RichOutputRunningPlaceholder,
  RichOutputToolErrorCard,
} from '../RichOutputErrorStates.section'
import {
  formatCount,
  getUrlHost,
  normalizeSearchResultItems,
  readNumber,
  readRecord,
  readString,
} from '../richOutputRenderModel'
import {
  RichOutputAnswerText,
  RichOutputMutedText,
} from '../RichOutputTextBlocks.section'
import { RichToolOutputCard } from '../RichToolOutputCard.section'

import styles from '../RichOutputToolRender.module.css'

import type { ToolCallBlock } from '#contracts'
import { openExternalUrl } from '#internal/externalNavigation'

export const SearchResultToolRender = memo(function SearchResultToolRender({
  block,
  compact,
}: {
  block: ToolCallBlock
  compact?: boolean
}): Nullable<React.ReactElement> {
  const { t } = useConversationI18n()
  const args = readRecord(block.args)
  const result = readRecord(block.result)
  const query = readString(args?.query) ?? t('chat.richSearchTitle')
  const answer = readString(result?.answer)
  const message = readString(result?.message)
  const count = readNumber(result?.count)
  const results = useMemo(
    () => normalizeSearchResultItems(result?.results, t('chat.richUntitled')),
    [result?.results, t]
  )

  if (block.error) return (
      <RichOutputToolErrorCard block={block} compact={compact} title={t('chat.richSearchTitle')} />
    )

  return (
    <RichToolOutputCard
      icon={
        block.isRunning ? (
          <SpinnerGapIcon size={14} className={styles.spinIcon} />
        ) : (
          <GlobeIcon size={14} />
        )
      }
      title={t('chat.richSearchTitle')}
      subtitle={query}
      badge={formatCount(count, results.length)}
      toolBlock={block}
      tone={block.isRunning ? 'running' : 'success'}
      compact={compact}
    >
      {block.isRunning ? (
        <RichOutputRunningPlaceholder label={t('chat.richSearchRunning')} />
      ) : (
        <>
          {!!answer && <RichOutputAnswerText>{answer}</RichOutputAnswerText>}
          {!!message && <RichOutputMutedText>{message}</RichOutputMutedText>}
          {results.length ? (
            <div className={styles.resultList}>
              {results.map((item, index) => (
                <Button
                  key={`${item.url || item.title}-${index}`}
                  variant="ghost"
                  size="block"
                  className={styles.searchItem}
                  onClick={() => {
                    openExternalUrl(item.url)
                  }}
                >
                  <span className={styles.searchMeta}>
                    <MagnifyingGlassIcon size={12} />
                    <Text>{getUrlHost(item.url) ?? t('chat.richSearchSource')}</Text>
                    {!!item.sourceId && (
                      <code className={styles.inlineCode}>{item.sourceId}</code>
                    )}
                  </span>
                  <Text className={styles.itemTitle}>{item.title}</Text>
                  {!!item.content && (
                    <Text className={styles.itemDescription}>{item.content}</Text>
                  )}
                </Button>
              ))}
            </div>
          ) : (!answer && !message) && (
            <RichOutputMutedText>{t('chat.richNoResults')}</RichOutputMutedText>
          )}
        </>
      )}
    </RichToolOutputCard>
  )
})
