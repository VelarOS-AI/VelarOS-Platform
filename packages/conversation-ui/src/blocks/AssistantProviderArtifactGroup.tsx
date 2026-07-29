import { memo, type ReactElement, useEffect, useMemo, useState } from 'react'
import { ArrowSquareOutIcon, CaretRightIcon } from '@phosphor-icons/react'

import { StyleUtils } from '@velaros-ai/ui'
import { ImagePreviewDialog } from '@velaros-ai/ui/primitives/overlays/ImagePreviewDialog'

import { useConversationI18n } from '../i18n'
import { AutoScrollSuspendEventName } from '../react-hooks/scrollBehavior'
import { useDisclosurePresence } from '../react-hooks/useDisclosurePresence'
import { useImagePreviewDialogMessages } from '../react-hooks/useImagePreviewDialogMessages'

import styles from './MessageBubble.module.css'

import type {
  AssistantGeneratedFileBlock,
  AssistantSourceBlock,
  ContentBlock,
} from '#contracts'
import { isEmpty,isPresent } from '#internal/runtime'

const cx = StyleUtils.bindCx(styles)
const RenderableImageMediaTypes = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

function isRenderableGeneratedImage(
  block: ContentBlock
): block is AssistantGeneratedFileBlock & { data: string } {
  return (
    block.type === 'assistant-generated-file' &&
    RenderableImageMediaTypes.has(block.mediaType.toLowerCase()) &&
    !!block.data
  )
}

function isRenderableSource(block: ContentBlock): block is AssistantSourceBlock {
  if (block.type !== 'assistant-source' || block.sourceType !== 'url') return false
  if (!URL.canParse(block.url)) return false
  const url = new URL(block.url)
  return url.protocol === 'https:' || url.protocol === 'http:'
}

function buildImageSrc(image: AssistantGeneratedFileBlock & { data: string }): string {
  return image.data.startsWith('data:')
    ? image.data
    : `data:${image.mediaType};base64,${image.data}`
}

function readSourceHost(source: AssistantSourceBlock): string {
  if (!URL.canParse(source.url)) return source.url
  return new URL(source.url).hostname.replace(/^www\./, '')
}

export function hasVisibleAssistantProviderArtifacts(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => isRenderableGeneratedImage(block) || isRenderableSource(block))
}

export const AssistantProviderArtifactGroup = memo(function AssistantProviderArtifactGroup({
  blocks,
  onOpenBrowserLink,
}: {
  blocks: ContentBlock[]
  onOpenBrowserLink?: (url: string) => void | Promise<void>
}): Nullable<ReactElement> {
  const { t } = useConversationI18n()
  const imagePreviewMessages = useImagePreviewDialogMessages()
  const [expanded, setExpanded] = useState(true)
  const [previewOpenIndex, setPreviewOpenIndex] = useState<Nullable<number>>(null)
  const { mounted: isMounted, visible: isVisible } = useDisclosurePresence(expanded)
  const images = useMemo(() => blocks.filter(isRenderableGeneratedImage), [blocks])
  const sources = useMemo(() => blocks.filter(isRenderableSource), [blocks])
  const previewItems = useMemo(
    () =>
      images.map((image, index) => {
        const title = image.filename?.trim() || `${t('chat.generatedImage')} ${index + 1}`
        return {
          id: image.id,
          src: buildImageSrc(image),
          alt: title,
          title,
        }
      }),
    [images, t]
  )

  useEffect(() => {
    if (!isPresent(previewOpenIndex)) return
    if (previewOpenIndex >= previewItems.length)
      setPreviewOpenIndex(previewItems.length ? previewItems.length - 1 : null)
  }, [previewItems.length, previewOpenIndex])

  if (isEmpty(images) && isEmpty(sources)) return null

  const itemCount = images.length + sources.length
  const label = `${t('chat.providerArtifacts')} · ${t('chat.providerArtifactCount', {
    count: itemCount,
  })}`

  return (
    <section
      className={cx('toolActivityDisclosure', 'browserScreenshotGroup')}
      aria-label={t('chat.providerArtifacts')}
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
              {!isEmpty(images) && (
                <div className={styles.browserScreenshotGrid}>
                  {images.map((image, index) => {
                    const title =
                      image.filename?.trim() || `${t('chat.generatedImage')} ${index + 1}`
                    return (
                      <button
                        key={image.id}
                        type="button"
                        className={styles.browserScreenshotCard}
                        aria-label={t('chat.openImagePreview')}
                        title={t('chat.openImagePreview')}
                        onClick={() => setPreviewOpenIndex(index)}
                      >
                        <img
                          className={styles.browserScreenshotImage}
                          src={buildImageSrc(image)}
                          alt={title}
                          draggable={false}
                        />
                        <span className={styles.browserScreenshotMeta}>
                          <span className={styles.browserScreenshotName}>{title}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {!isEmpty(sources) && (
                <div className={styles.providerSourceList}>
                  <span className={styles.providerSourceHeading}>{t('chat.providerSources')}</span>
                  {sources.map((source) => (
                    <button
                      key={source.id}
                      type="button"
                      className={styles.providerSourceLink}
                      title={source.url}
                      onClick={() => void onOpenBrowserLink?.(source.url)}
                    >
                      <span className={styles.providerSourceText}>
                        <span className={styles.providerSourceTitle}>
                          {source.title?.trim() || readSourceHost(source)}
                        </span>
                        <span className={styles.providerSourceHost}>{readSourceHost(source)}</span>
                      </span>
                      <ArrowSquareOutIcon size={15} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
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
