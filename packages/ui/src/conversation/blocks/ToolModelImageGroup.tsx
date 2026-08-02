import { memo, type ReactElement, useEffect, useMemo, useState } from 'react'
import { CaretRightIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { ImagePreviewDialog } from '@velaros-ai/ui/primitives/overlays/ImagePreviewDialog'

import { useConversationI18n } from '../i18n'
import { AutoScrollSuspendEventName } from '../react-hooks/scrollBehavior'
import { useDisclosurePresence } from '../react-hooks/useDisclosurePresence'
import { useImagePreviewDialogMessages } from '../react-hooks/useImagePreviewDialogMessages'

import styles from './MessageBubble.module.css'

import type { ContentBlock, ToolCallBlock as ToolCallBlockType } from '#contracts'
import { isBlank, isEmpty, isPresent, isRecord } from '#internal/runtime'
import {
  readNumberScalar as readNumber,
  readStringScalar as readString,
} from '#internal/unknownJsonRecord'

const cx = StyleUtils.bindCx(styles)

interface ToolModelImage {
  id: string
  toolName: string
  data: string
  mediaType: 'image/png' | 'image/jpeg'
  title: string
  description: string
}

function buildModelImageSrc(image: Pick<ToolModelImage, 'data' | 'mediaType'>): string {
  return image.data.startsWith('data:') ? image.data : `data:${image.mediaType};base64,${image.data}`
}

function isBrowserScreenshotBackedBlock(block: ToolCallBlockType): boolean {
  if (block.toolName === 'browser:capture_screenshot') return true
  if (!isRecord(block.result)) return false

  return isRecord(block.result.automaticScreenshot)
}

function readDisplayPath(block: ToolCallBlockType): Nullable<string> {
  const args = isRecord(block.args) ? block.args : null
  const result = isRecord(block.result) ? block.result : null

  return (
    readString(args?.path) ??
    readString(args?.filePath) ??
    readString(args?.imagePath) ??
    readString(result?.relativePath) ??
    readString(result?.path) ??
    readString(result?.filePath) ??
    readString(result?.imagePath)
  )
}

function readImageDescription(block: ToolCallBlockType): string {
  const result = isRecord(block.result) ? block.result : null
  const width = readNumber(result?.width)
  const height = readNumber(result?.height)
  const sizeLabel = width && height ? `${width}x${height}` : ''

  return [block.toolName, sizeLabel].filter((value) => !!value).join(' · ')
}

function readToolModelImage(block: ToolCallBlockType): Nullable<ToolModelImage> {
  if (isBrowserScreenshotBackedBlock(block)) return null

  const image = block.modelImage
  if (!image || isBlank(image.data)) return null

  const title = readDisplayPath(block) ?? block.toolName

  return {
    id: `${block.toolCallId}:${image.mediaType}:${title}`,
    toolName: block.toolName,
    data: image.data,
    mediaType: image.mediaType,
    title,
    description: readImageDescription(block),
  }
}

function collectToolModelImages(blocks: ContentBlock[]): ToolModelImage[] {
  const images: ToolModelImage[] = []

  for (const block of blocks) {
    if (block.type !== 'tool-call') continue

    const image = readToolModelImage(block)
    if (image) images.push(image)
  }

  return images
}

export function hasVisibleToolModelImages(blocks: ContentBlock[]): boolean {
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    if (readToolModelImage(block)) return true
  }

  return false
}

interface ToolModelImageCardProps {
  image: ToolModelImage
  index: number
  onOpen: (index: number) => void
}

function ToolModelImageCard({
  image,
  index,
  onOpen,
}: ToolModelImageCardProps): ReactElement {
  const { t } = useConversationI18n()

  return (
    <button
      type="button"
      className={styles.browserScreenshotCard}
      aria-label={t('chat.openImagePreview')}
      title={t('chat.openImagePreview')}
      onClick={() => onOpen(index)}
    >
      <img
        className={styles.browserScreenshotImage}
        src={buildModelImageSrc(image)}
        alt={image.title}
        draggable={false}
      />
      <span className={styles.browserScreenshotMeta}>
        <span className={styles.browserScreenshotName}>{image.title}</span>
        {!!image.description && (
          <span className={styles.browserScreenshotStats}>{image.description}</span>
        )}
      </span>
    </button>
  )
}

export const ToolModelImageGroup = memo(function ToolModelImageGroup({
  blocks,
}: {
  blocks: ContentBlock[]
}): Nullable<ReactElement> {
  const { t } = useConversationI18n()
  const imagePreviewMessages = useImagePreviewDialogMessages()
  const [expanded, setExpanded] = useState(true)
  const [previewOpenIndex, setPreviewOpenIndex] = useState<Nullable<number>>(null)
  const { mounted: isMounted, visible: isVisible } = useDisclosurePresence(expanded)
  const images = useMemo(() => collectToolModelImages(blocks), [blocks])
  const previewItems = useMemo(
    () =>
      images.map((image) => ({
        id: image.id,
        src: buildModelImageSrc(image),
        alt: image.title,
        title: image.title,
        description: image.description,
      })),
    [images]
  )

  useEffect(() => {
    if (!isPresent(previewOpenIndex)) return

    if (previewOpenIndex >= previewItems.length) {
      setPreviewOpenIndex(previewItems.length ? previewItems.length - 1 : null)
    }
  }, [previewItems.length, previewOpenIndex])

  if (isEmpty(images)) return null

  const label = `${t('browser.modelImageGroup')} · ${t('browser.screenshotGroupCount', {
    count: images.length,
  })}`

  return (
    <section
      className={cx('toolActivityDisclosure', 'browserScreenshotGroup')}
      aria-label={t('browser.modelImageGroup')}
    >
      <button
        type="button"
        className={styles.toolActivityToggle}
        aria-expanded={expanded}
        title={label}
        onClick={(event) => {
          event.currentTarget.dispatchEvent(
            new Event(AutoScrollSuspendEventName, { bubbles: true })
          )
          setExpanded((value) => !value)
        }}
      >
        <span className={styles.toolActivityLabel}>{label}</span>
        <CaretRightIcon
          size={14}
          weight="bold"
          className={cx('toolActivityChevron', expanded && 'toolActivityChevronExpanded')}
          aria-hidden="true"
        />
      </button>
      {isMounted && (
        <div
          className={cx(
            'toolActivityBodyShell',
            expanded && isVisible && 'toolActivityBodyShellExpanded'
          )}
          aria-hidden={!isVisible}
        >
          <div className={styles.toolActivityBodyFrame}>
            <div className={styles.toolActivityBody}>
              <div className={styles.browserScreenshotGrid}>
                {images.map((image, index) => (
                  <ToolModelImageCard
                    key={image.id}
                    image={image}
                    index={index}
                    onOpen={setPreviewOpenIndex}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      <ImagePreviewDialog
        items={previewItems}
        openIndex={previewOpenIndex}
        onOpenIndexChange={setPreviewOpenIndex}
        messages={imagePreviewMessages}
      />
    </section>
  )
})
