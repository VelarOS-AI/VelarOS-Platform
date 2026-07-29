import { type KeyboardEvent, memo, type ReactElement } from 'react'
import { FolderOpenIcon, TerminalWindowIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { FileTypeIcon } from '@velaros-ai/ui/primitives/display/FileTypeIcon'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { getFilePresentationKind } from '@velaros-ai/ui/utils/filePresentation'

import type { ConversationActionItem } from '../projection'

import styles from './MessageActionRow.module.css'

import { optionalWhen, optionalWhenLazy } from '#internal/runtime'

interface MessageActionRowProps {
  item: ConversationActionItem
  displayTitle?: string
  onClick?: (item: ConversationActionItem) => void
  onReveal?: (item: ConversationActionItem) => void
  revealLabel?: string
}

const cx = StyleUtils.bindCx(styles)
const ActionFileIconColor = 'var(--icon-fg)'

function getActionFileName(item: ConversationActionItem): string {
  return item.openPath ?? item.detail ?? item.title
}

function getActionIcon(item: ConversationActionItem): ReactElement {
  return item.action === 'log' ? (
    <TerminalWindowIcon size={14} weight="duotone" />
  ) : (
    <FileTypeIcon
      fileName={getActionFileName(item)}
      size={14}
      weight="duotone"
      color={ActionFileIconColor}
    />
  )
}

function getFileKindClass(item: ConversationActionItem): Nullable<keyof typeof styles> {
  if (item.action === 'log') return null

  switch (getFilePresentationKind({ fileName: getActionFileName(item) })) {
    case 'archive':
      return 'fileKindArchive'
    case 'audio':
      return 'fileKindAudio'
    case 'code':
      return 'fileKindCode'
    case 'csv':
      return 'fileKindCsv'
    case 'html':
      return 'fileKindHtml'
    case 'markdown':
      return 'fileKindMarkdown'
    case 'text':
      return 'fileKindText'
    case 'document':
      return 'fileKindDocument'
    case 'pdf':
      return 'fileKindPdf'
    case 'image':
      return 'fileKindImage'
    case 'presentation':
      return 'fileKindPresentation'
    case 'spreadsheet':
      return 'fileKindSpreadsheet'
    case 'video':
      return 'fileKindVideo'
    case 'generic':
    default:
      return 'fileKindGeneric'
  }
}

export const MessageActionRow = memo(
  ({
    item,
    displayTitle,
    onClick,
    onReveal,
    revealLabel = 'Open containing folder',
  }: MessageActionRowProps): ReactElement => {
    const clickable = !!item.openPath && !!onClick
    const revealable = !!item.openPath && !!onReveal
    const fileKindClass = getFileKindClass(item)
    const title = displayTitle?.trim() || item.title
    const handleClick = (): void => {
      if (clickable) {
        onClick?.(item)
      }
    }
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      if (!clickable || event.defaultPrevented) return

      if (event.key !== 'Enter' && event.key !== ' ') return

      event.preventDefault()
      onClick?.(item)
    }

    return (
      <div
        className={cx(
          'root',
          clickable ? 'clickable' : false,
          item.action ? item.action : false,
          fileKindClass ? fileKindClass : false
        )}
        role={optionalWhenLazy(clickable, () => 'button')}
        tabIndex={optionalWhenLazy(clickable, () => 0)}
        title={title}
        onClick={optionalWhen(clickable, handleClick)}
        onKeyDown={handleKeyDown}
      >
        <span className={styles.iconWrap}>{getActionIcon(item)}</span>
        <span className={styles.content}>
          <Text className={styles.title}>{title}</Text>
        </span>
        {revealable && (
          <span className={styles.actionSlot}>
            <IconButton
              size="icon-sm"
              className={styles.revealButton}
              label={revealLabel}
              title={revealLabel}
              onClick={(event) => {
                event.stopPropagation()
                onReveal?.(item)
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <FolderOpenIcon size={14} weight="duotone" />
            </IconButton>
          </span>
        )}
      </div>
    )
  }
)

MessageActionRow.displayName = 'MessageActionRow'
