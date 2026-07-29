import React, { memo, useMemo } from 'react'
import { GitCommitIcon, SpinnerGapIcon } from '@phosphor-icons/react'

import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n } from '../../../i18n'
import {
  RichOutputRunningPlaceholder,
  RichOutputToolErrorCard,
} from '../RichOutputErrorStates.section'
import {
  formatCount,
  formatDate,
  readGitCommits,
  readNumber,
  readRecord,
} from '../richOutputRenderModel'
import { RichOutputMutedText } from '../RichOutputTextBlocks.section'
import { RichToolOutputCard } from '../RichToolOutputCard.section'

import styles from '../RichOutputToolRender.module.css'

import type { ToolCallBlock } from '#contracts'

export const GitCommitsToolRender = memo(function GitCommitsToolRender({
  block,
  compact,
}: {
  block: ToolCallBlock
  compact?: boolean
}): Nullable<React.ReactElement> {
  const { locale, t } = useConversationI18n()
  const result = readRecord(block.result)
  const count = readNumber(result?.count)
  const commits = useMemo(() => readGitCommits(result), [result])

  if (block.error) return (
      <RichOutputToolErrorCard block={block} compact={compact} title={t('chat.richGitTitle')} />
    )

  return (
    <RichToolOutputCard
      icon={
        block.isRunning ? (
          <SpinnerGapIcon size={14} className={styles.spinIcon} />
        ) : (
          <GitCommitIcon size={14} />
        )
      }
      title={t('chat.richGitTitle')}
      badge={formatCount(count, commits.length)}
      toolBlock={block}
      tone={block.isRunning ? 'running' : 'success'}
      compact={compact}
    >
      {block.isRunning ? (
        <RichOutputRunningPlaceholder label={t('chat.richGitRunning')} />
      ) : commits.length ? (
        <div className={styles.commitList}>
          {commits.map((commit) => (
            <article key={commit.hash || commit.shortHash} className={styles.commitItem}>
              <code className={styles.commitHash}>{commit.shortHash}</code>
              <div className={styles.commitBody}>
                <Text className={styles.itemTitle}>{commit.subject || commit.hash}</Text>
                <Text className={styles.itemMeta}>
                  {[commit.authorName, formatDate(commit.date, locale), commit.refs]
                    .filter((value) => !!value)
                    .join(' · ')}
                </Text>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <RichOutputMutedText>{t('chat.richNoResults')}</RichOutputMutedText>
      )}
    </RichToolOutputCard>
  )
})
