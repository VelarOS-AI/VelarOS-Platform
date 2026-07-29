import { memo, type ReactElement, useMemo } from 'react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { FileTypeIcon } from '@velaros-ai/ui/primitives/display/FileTypeIcon'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import {
  buildImageAttachmentSrc,
  formatAttachmentSize,
} from './messageBubbleRenderModel'

import styles from './MessageBubble.module.css'

import type { ChatAttachmentMeta, SerializedImageAttachment } from '#contracts'
import { isEmpty } from '#internal/runtime'

interface UserAttachmentGalleryModel {
  previewImages: Array<{
    attachment: ChatAttachmentMeta
    imageAttachment: SerializedImageAttachment
  }>
  fileLikeAttachments: ChatAttachmentMeta[]
}

const EmptyUserAttachmentGalleryModel: UserAttachmentGalleryModel = {
  previewImages: [],
  fileLikeAttachments: [],
}

function buildUserAttachmentGalleryModel(
  attachments: readonly ChatAttachmentMeta[],
  imageAttachments: readonly SerializedImageAttachment[]
): UserAttachmentGalleryModel {
  if (!attachments.length) return EmptyUserAttachmentGalleryModel

  let imageAttachmentMap: Nullable<Map<string, SerializedImageAttachment>> = null
  if (imageAttachments.length) {
    imageAttachmentMap = new Map()
    for (const attachment of imageAttachments) {
      imageAttachmentMap.set(attachment.id, attachment)
    }
  }
  const previewImages: UserAttachmentGalleryModel['previewImages'] = []
  const fileLikeAttachments: ChatAttachmentMeta[] = []

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      const imageAttachment = imageAttachmentMap?.get(attachment.id)
      if (imageAttachment) {
        previewImages.push({ attachment, imageAttachment })
        continue
      }
    }

    fileLikeAttachments.push(attachment)
  }

  return {
    previewImages,
    fileLikeAttachments,
  }
}

function UserAttachmentGalleryInner({
  attachments,
  imageAttachments,
  previewLabel,
  onPreviewImage,
}: {
  attachments: ChatAttachmentMeta[]
  imageAttachments: SerializedImageAttachment[]
  previewLabel: string
  onPreviewImage: (index: number) => void
}): Nullable<ReactElement> {
  const { previewImages, fileLikeAttachments } = useMemo(
    () => buildUserAttachmentGalleryModel(attachments, imageAttachments),
    [attachments, imageAttachments]
  )
  if (!attachments.length) return null

  return (
    <div className={styles.userAttachmentStack}>
      {!isEmpty(previewImages) && (
        <div className={styles.userAttachmentGrid}>
          {previewImages.map(({ attachment, imageAttachment }, imageIndex) => {
            const src = buildImageAttachmentSrc(imageAttachment)

            return (
              <Button
                variant="ghost"
                size="block"
                key={attachment.id}
                className={styles.userImageCard}
                onClick={() => onPreviewImage(imageIndex)}
                aria-label={previewLabel}
              >
                <img
                  src={src}
                  alt={attachment.name}
                  className={styles.userImagePreview}
                  loading="lazy"
                />
                <div className={styles.userImageMeta}>
                  <Text className={styles.userImageName} title={attachment.name}>
                    {attachment.name}
                  </Text>
                  <Text className={styles.userImageSize}>{formatAttachmentSize(attachment.size)}</Text>
                </div>
              </Button>
            )
          })}
        </div>
      )}

      {!isEmpty(fileLikeAttachments) && (
        <div className={styles.userFileList}>
          {fileLikeAttachments.map((attachment) => (
            <div key={attachment.id} className={styles.userFileChip}>
              <FileTypeIcon
                fileName={attachment.name}
                mediaType={attachment.mediaType}
                size={14}
                className={styles.userFileIcon}
              />
              <div className={styles.userFileMeta}>
                <div className={styles.userFileName} title={attachment.name}>
                  {attachment.name}
                </div>
                <div className={styles.userFileSize}>{formatAttachmentSize(attachment.size)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const UserAttachmentGallery = memo(UserAttachmentGalleryInner)

UserAttachmentGallery.displayName = 'UserAttachmentGallery'
