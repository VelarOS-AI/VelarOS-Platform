import { memo, useMemo } from 'react'
import { XIcon } from '@phosphor-icons/react'
import type { KeyboardEvent, MouseEvent, ReactElement } from 'react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { FileTypeIcon } from '@velaros-ai/ui/primitives/display/FileTypeIcon'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'

import { ChatInputImageThumb } from './ChatInputImageThumb'
import { formatChatInputFileSize } from './chatInputUtils'

import styles from './ChatInput.module.css'

export interface ComposerFilePreviewProps {
  files: readonly File[]
  disabled: boolean
  imageOpenPreviewLabel: string
  removeFileLabel: string
  /** 图片子集内的索引，与图片来源文件列表平行。 */
  onPreviewImageSubsetIndex: (imageSubsetIndex: number) => void
  /** 完整文件数组内的索引，用于移除文件。 */
  onRemoveFileAtFilesIndex: (filesIndex: number) => void
  onOpenFile?: (file: File) => void | Promise<void>
}

interface ComposerFilePreviewEntry {
  file: File
  index: number
}

interface ComposerFilePreviewModel {
  imageEntries: ComposerFilePreviewEntry[]
  otherEntries: ComposerFilePreviewEntry[]
}

function buildComposerFilePreviewModel(files: readonly File[]): ComposerFilePreviewModel {
  const imageEntries: ComposerFilePreviewEntry[] = []
  const otherEntries: ComposerFilePreviewEntry[] = []

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    if (!file) continue

    const entry = { file, index }
    if (file.type.startsWith('image/')) {
      imageEntries.push(entry)
    } else {
      otherEntries.push(entry)
    }
  }

  return {
    imageEntries,
    otherEntries,
  }
}

function ComposerFilePreviewInner({
  files,
  disabled,
  imageOpenPreviewLabel,
  removeFileLabel,
  onPreviewImageSubsetIndex,
  onRemoveFileAtFilesIndex,
  onOpenFile,
}: ComposerFilePreviewProps): Nullable<ReactElement> {
  const { imageEntries, otherEntries } = useMemo(
    () => buildComposerFilePreviewModel(files),
    [files]
  )

  if (!files.length) return null

  return (
    <Stack className={styles.filePreview} gap="none">
      <Inline className={styles.fileList} gap="sm" wrap="wrap" align="end">
        {imageEntries.map(({ file, index: filesIndex }, subsetIndex) => (
          <ChatInputImageThumb
            key={`${file.name}-${filesIndex}-${file.size}-${file.lastModified}`}
            file={file}
            previewLabel={imageOpenPreviewLabel}
            onPreview={() => onPreviewImageSubsetIndex(subsetIndex)}
            onRemove={() => onRemoveFileAtFilesIndex(filesIndex)}
            disabled={disabled}
            removeLabel={removeFileLabel}
          />
        ))}
        {otherEntries.map(({ file, index: filesIndex }) => {
          const isOpenable = !!onOpenFile

          return (
            <Inline
              key={`${file.name}-${filesIndex}-${file.size}`}
              className={styles.fileChip}
              gap="sm"
              role={isOpenable ? 'button' : undefined}
              tabIndex={isOpenable ? 0 : undefined}
              data-openable={isOpenable ? 'true' : undefined}
              onClick={isOpenable ? () => onOpenFile(file) : undefined}
              onKeyDown={
                isOpenable
                  ? (event: KeyboardEvent<HTMLDivElement>) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        void onOpenFile(file)
                      }
                    }
                  : undefined
              }
            >
              <FileTypeIcon
                fileName={file.name}
                mediaType={file.type}
                size={14}
                className={styles.fileChipIcon}
              />
              <div className={styles.fileChipMeta}>
                <div className={styles.fileChipName} title={file.name}>
                  {file.name}
                </div>
                <div className={styles.fileChipSize}>{formatChatInputFileSize(file.size)}</div>
              </div>
              <IconButton
                label={removeFileLabel}
                size="icon-sm"
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation()
                  onRemoveFileAtFilesIndex(filesIndex)
                }}
                disabled={disabled}
                className={styles.fileChipRemove}
              >
                <XIcon size={12} />
              </IconButton>
            </Inline>
          )
        })}
      </Inline>
    </Stack>
  )
}

export const ComposerFilePreview = memo(ComposerFilePreviewInner)

ComposerFilePreview.displayName = 'ComposerFilePreview'
