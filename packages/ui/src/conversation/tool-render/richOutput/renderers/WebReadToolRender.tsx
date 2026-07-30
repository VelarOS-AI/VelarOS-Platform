import React, { memo } from 'react'
import {
  ArrowSquareOutIcon,
  FileTextIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n } from '../../../i18n'
import {
  RichOutputRunningPlaceholder,
  RichOutputToolErrorCard,
} from '../RichOutputErrorStates.section'
import {
  getUrlHost,
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
import { isPresent, isTrue, optionalWhen } from '#internal/runtime'

export const WebReadToolRender = memo(function WebReadToolRender({
  block,
  compact,
}: {
  block: ToolCallBlock
  compact?: boolean
}): Nullable<React.ReactElement> {
  const { t } = useConversationI18n()
  const args = readRecord(block.args)
  const result = readRecord(block.result)
  const sourceId = readString(result?.source_id) ?? readString(args?.source_id)
  const title = readString(result?.title) ?? sourceId ?? t('chat.richWebReadTitle')
  const url = readString(result?.url)
  const content = readString(result?.content)
  const message = readString(result?.message)
  const hasToolError = isTrue(result?.error)
  const chunkIndex = readNumber(result?.chunk_index)
  const totalChunks = readNumber(result?.total_chunks)
  let badge: string | undefined
  if (chunkIndex && totalChunks) {
    badge = `${chunkIndex}/${totalChunks}`
  } else if (isPresent(sourceId)) {
    badge = sourceId
  }

  if (block.error) return (
      <RichOutputToolErrorCard block={block} compact={compact} title={t('chat.richWebReadTitle')} />
    )

  return (
    <RichToolOutputCard
      icon={
        block.isRunning ? (
          <SpinnerGapIcon size={14} className={styles.spinIcon} />
        ) : hasToolError ? (
          <WarningCircleIcon size={14} weight="fill" />
        ) : (
          <FileTextIcon size={14} />
        )
      }
      title={t('chat.richWebReadTitle')}
      subtitle={title}
      badge={badge}
      toolBlock={block}
      tone={block.isRunning ? 'running' : hasToolError ? 'error' : 'success'}
      compact={compact}
      actions={
        optionalWhen(url, ((
          <IconButton
            label={t('chat.richOpenSource')}
            size="icon-sm"
            variant="ghost"
            className={styles.actionButton}
            onClick={() => {
              openExternalUrl(url)
            }}
          >
            <ArrowSquareOutIcon size={14} />
          </IconButton>
        )))
      }
    >
      {block.isRunning ? (
        <RichOutputRunningPlaceholder label={t('chat.richWebReadRunning')} />
      ) : hasToolError ? (
        <RichOutputMutedText>{message ?? t('chat.richWebReadFailed')}</RichOutputMutedText>
      ) : (
        <div className={styles.artifactPanel}>
          {!!url && <Text className={styles.searchMeta}>{getUrlHost(url) ?? url}</Text>}
          {content ? (
            <RichOutputAnswerText>{content}</RichOutputAnswerText>
          ) : (
            <RichOutputMutedText>{t('chat.richNoResults')}</RichOutputMutedText>
          )}
        </div>
      )}
    </RichToolOutputCard>
  )
})
