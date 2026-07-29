import { useMemo } from 'react'

import { type ImagePreviewDialogMessages } from '@velaros-ai/ui/primitives/overlays/ImagePreviewDialog'

import { useConversationI18n, useConversationTranslatorRuntime } from '../i18n'

/**
 * 图片预览对话框的本地化文案（走会话 i18n seam）。随图片组渲染件入包;宿主
 * `@hooks/ui/useImagePreviewDialogMessages` 另有同源副本（随参考壳退场）。
 */
export function useImagePreviewDialogMessages(): ImagePreviewDialogMessages {
  const { t, locale } = useConversationI18n()
  const translatorRuntime = useConversationTranslatorRuntime()

  return useMemo(
    () => ({
      closeImagePreview: t('chat.closeImagePreview'),
      previousImage: t('chat.previousImage'),
      nextImage: t('chat.nextImage'),
      imagePreviewCounter:
        translatorRuntime.lookupMessage(locale, 'chat.imagePreviewCounter') ??
        'chat.imagePreviewCounter',
      imagePreviewZoomOut: t('chat.imagePreviewZoomOut'),
      imagePreviewZoomIn: t('chat.imagePreviewZoomIn'),
      imagePreviewZoomLevel: t('chat.imagePreviewZoomLevel'),
      imagePreviewResetZoom: t('chat.imagePreviewResetZoom'),
    }),
    [locale, t, translatorRuntime]
  )
}
