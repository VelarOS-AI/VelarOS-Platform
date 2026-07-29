import React from 'react'
import { XIcon } from '@phosphor-icons/react'
import * as DialogPrimitive from '@radix-ui/react-dialog'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'

import { useConversationI18n } from '../i18n'

import styles from './HtmlPreview.module.css'

/**
 * Widget 与 HTML Artifact 通过中立预览适配层共用的全屏层:不透明应用背景全屏融入、
 * 零面板框,顶栏=标题+可选状态行+关闭。生成期增量预览与手动全屏预览走同一实现——
 * 共享 `velar-image-preview-*` 类是给暗底图片预览设计的白字,这里逐项覆写成应用前景配色。
 */
export function HtmlPreviewFullscreenLayer({
  open,
  onOpenChange,
  title,
  statusText,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** 有值时在标题下显示运行圆点+状态文案(生成中);省略则只有标题。 */
  statusText?: LooseOptional<string>
  children: React.ReactNode
}): React.ReactElement {
  const { t } = useConversationI18n()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={`velar-image-preview-dialog-overlay ${styles.generationOverlay}`}
        />
        <DialogPrimitive.Content
          className={`velar-image-preview-dialog-content ${styles.generationContent}`}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className={`velar-image-preview-dialog-top-bar ${styles.generationTopBar}`}>
            <div className={`velar-image-preview-dialog-meta ${styles.generationMeta}`}>
              <DialogTitle className={`velar-image-preview-dialog-title ${styles.generationTitle}`}>
                {title}
              </DialogTitle>
              {!!statusText && (
                <p className={`velar-image-preview-dialog-subtitle ${styles.generationSubtitle}`}>
                  <span
                    className={`${styles.runningDot} ${styles.generationStatusDot}`}
                    aria-hidden="true"
                  />
                  {statusText}
                </p>
              )}
            </div>
            <DialogClose asChild>
              <IconButton
                label={t('common.close')}
                size="icon-sm"
                className={`velar-image-preview-dialog-close-button ${styles.generationCloseButton}`}
              >
                <XIcon size={18} weight="bold" />
              </IconButton>
            </DialogClose>
          </div>
          <div className={styles.generationViewport}>
            <div className={styles.generationFrame}>{children}</div>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
