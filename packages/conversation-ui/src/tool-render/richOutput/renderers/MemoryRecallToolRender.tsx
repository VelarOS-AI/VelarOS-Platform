import React, { memo, useMemo } from 'react'
import { BrainIcon, DatabaseIcon, SpinnerGapIcon } from '@phosphor-icons/react'

import { Badge } from '@velaros-ai/ui/primitives/display/Badge'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n } from '../../../i18n'
import {
  RichOutputRunningPlaceholder,
  RichOutputToolErrorCard,
} from '../RichOutputErrorStates.section'
import {
  compactText,
  formatCount,
  formatDate,
  getMemoryTitle,
  readMemoryItems,
  readNumber,
  readRecord,
  readString,
} from '../richOutputRenderModel'
import {
  RichOutputAnswerText,
  RichOutputItemDetailText,
  RichOutputMutedText,
} from '../RichOutputTextBlocks.section'
import { RichToolOutputCard } from '../RichToolOutputCard.section'

import styles from '../RichOutputToolRender.module.css'

import type { ToolCallBlock } from '#contracts'

export const MemoryRecallToolRender = memo(function MemoryRecallToolRender({
  block,
  compact,
}: {
  block: ToolCallBlock
  compact?: boolean
}): Nullable<React.ReactElement> {
  const { locale, t } = useConversationI18n()
  const args = readRecord(block.args)
  const result = readRecord(block.result)
  const memoryMode = readString(result?.mode) ?? readString(args?.mode)
  const headerTitle = getMemoryTitle(block.toolName, t, memoryMode)
  const subtitle =
    (readString(args?.query) ??
      readString(args?.name) ??
      readString(result?.entity) ??
      readString(args?.kind)) ||
    undefined
  const count = readNumber(result?.count)
  const memories = useMemo(() => readMemoryItems(result), [result])
  const profile = readString(result?.profile)

  if (block.error) return <RichOutputToolErrorCard block={block} compact={compact} title={headerTitle} />

  return (
    <RichToolOutputCard
      icon={
        block.isRunning ? (
          <SpinnerGapIcon size={14} className={styles.spinIcon} />
        ) : memoryMode === 'browse' ? (
          <DatabaseIcon size={14} />
        ) : (
          <BrainIcon size={14} />
        )
      }
      title={headerTitle}
      subtitle={subtitle}
      badge={formatCount(count, memories.length)}
      toolBlock={block}
      tone={block.isRunning ? 'running' : 'success'}
      compact={compact}
    >
      {block.isRunning ? (
        <RichOutputRunningPlaceholder label={t('chat.richMemoryRunning')} />
      ) : (
        <>
          {!!profile && <RichOutputAnswerText>{profile}</RichOutputAnswerText>}
          {memories.length ? (
            <div className={styles.memoryList}>
              {memories.map((memory) => (
                <article
                  key={memory.id || `${memory.kind}-${memory.title}`}
                  className={styles.memoryItem}
                >
                  <div className={styles.itemHeader}>
                    <Text className={styles.itemTitle}>{memory.title}</Text>
                    <Badge variant="outline" className={styles.badge}>
                      {memory.kind}
                    </Badge>
                  </div>
                  <RichOutputItemDetailText>
                    {memory.snippet ?? memory.summary ?? compactText(memory.content ?? '', 220)}
                  </RichOutputItemDetailText>
                  <div className={styles.itemMeta}>
                    {!!memory.source && <Text>{memory.source}</Text>}
                    {!!formatDate(memory.updatedAt ?? memory.createdAt, locale) && (
                      <Text>{formatDate(memory.updatedAt ?? memory.createdAt, locale)}</Text>
                    )}
                    {memory.tags?.slice(0, 4).map((tag) => (
                      <Text key={tag}>#{tag}</Text>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : !profile && (
            <RichOutputMutedText>{t('chat.richNoResults')}</RichOutputMutedText>
          )}
        </>
      )}
    </RichToolOutputCard>
  )
})
