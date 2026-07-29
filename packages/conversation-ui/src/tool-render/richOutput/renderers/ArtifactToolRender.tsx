import React, { memo } from 'react'
import {
  ArrowSquareOutIcon,
  FileTextIcon,
  FolderOpenIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n } from '../../../i18n'
import { useChatToolRenderCapabilities } from '../../chatToolRenderCapabilitiesContext'
import {
  RichOutputRunningPlaceholder,
  RichOutputToolErrorCard,
} from '../RichOutputErrorStates.section'
import {
  formatBytes,
  readNumber,
  readRecord,
  readString,
} from '../richOutputRenderModel'
import { RichToolOutputCard } from '../RichToolOutputCard.section'

import styles from '../RichOutputToolRender.module.css'

import type { ToolCallBlock } from '#contracts'
import { AppError, Result } from '#internal/result'
import { optionalWhen } from '#internal/runtime'

export const ArtifactToolRender = memo(function ArtifactToolRender({
  block,
  compact,
  sessionId,
  formatPathForDisplay,
}: {
  block: ToolCallBlock
  compact?: boolean
  sessionId?: string
  formatPathForDisplay?: (path: string) => string
}): Nullable<React.ReactElement> {
  const capabilities = useChatToolRenderCapabilities()
  const { t } = useConversationI18n()
  const args = readRecord(block.args)
  const result = readRecord(block.result)
  const path = readString(result?.path)
  const displayPath = path && formatPathForDisplay ? formatPathForDisplay(path) : path
  const filename =
    readString(result?.filename) ??
    readString(args?.filename) ??
    (path ? path.split(/[\\/]/).pop() : null) ??
    t('chat.richArtifactTitle')
  const artifactType = readString(result?.type) ?? readString(args?.type)
  const bytes = formatBytes(readNumber(result?.bytes))
  const title = readString(result?.title) ?? readString(args?.title) ?? filename
  const subtitle = [filename, bytes].filter((value) => !!value).join(' · ')

  if (block.error) return (
      <RichOutputToolErrorCard
        block={block}
        compact={compact}
        title={t('chat.richArtifactTitle')}
      />
    )

  async function openPath(kind: 'open' | 'reveal'): Promise<void> {
    const openWorkspacePath = capabilities.openWorkspacePath
    const revealWorkspacePath = capabilities.revealWorkspacePath

    if (!sessionId || !path) return

    try {
      if (kind === 'open') {
        if (!openWorkspacePath) return
        Result.unwrap(await openWorkspacePath(sessionId, path))
      } else {
        if (!revealWorkspacePath) return
        Result.unwrap(await revealWorkspacePath(sessionId, path))
      }
    } catch (errorValue) {
      capabilities.showNotice?.({
        title: t('chat.richOpenFailed'),
        description: AppError.getMessage(errorValue),
        tone: 'error',
      })
    }
  }

  return (
    <RichToolOutputCard
      icon={
        block.isRunning ? (
          <SpinnerGapIcon size={14} className={styles.spinIcon} />
        ) : (
          <FileTextIcon size={14} />
        )
      }
      title={t('chat.richArtifactTitle')}
      subtitle={subtitle || title}
      badge={artifactType}
      toolBlock={block}
      tone={block.isRunning ? 'running' : 'success'}
      compact={compact}
      actions={
        optionalWhen(path, ((
          <>
            <IconButton
              label={t('chat.richRevealArtifact')}
              size="icon-sm"
              variant="ghost"
              className={styles.actionButton}
              disabled={!sessionId}
              onClick={() => {
                void openPath('reveal')
              }}
            >
              <FolderOpenIcon size={14} />
            </IconButton>
            <IconButton
              label={t('chat.richOpenArtifact')}
              size="icon-sm"
              variant="ghost"
              className={styles.actionButton}
              disabled={!sessionId}
              onClick={() => {
                void openPath('open')
              }}
            >
              <ArrowSquareOutIcon size={14} />
            </IconButton>
          </>
        )))
      }
    >
      {block.isRunning ? (
        <RichOutputRunningPlaceholder label={t('chat.richArtifactRunning')} />
      ) : (
        <div className={styles.artifactPanel}>
          <Text className={styles.itemTitle}>{title}</Text>
          {!!displayPath && <code className={styles.pathText}>{displayPath}</code>}
        </div>
      )}
    </RichToolOutputCard>
  )
})
