import type { ReactElement } from 'react'

import { StyleUtils } from '@velaros-ai/ui'

import { useConversationI18n } from '../i18n'

import styles from './ChatConversationSkeleton.module.css'

const cx = StyleUtils.bindCx(styles)

interface ChatConversationSkeletonProps {
  variant?: 'default' | 'side'
  composer?: LooseOptional<ReactElement>
}

/**
 * 聊天区域加载骨架。
 * 显示固定的三气泡占位，session 数据从磁盘加载完成后自动替换。
 */
function ChatConversationSkeleton({
  variant = 'default',
  composer,
}: ChatConversationSkeletonProps): ReactElement {
  const { t } = useConversationI18n()
  const isSide = variant === 'side'

  return (
    <section className={styles.root} aria-busy="true" aria-label={t('chat.loadingConversation')}>
      <div className={styles.messageList}>
        <div
          className={cx("messageListInner", isSide && "messageListInnerSide")}
        >
          <div className={styles.row}>
            <div className={cx("bubble", isSide && "bubbleCompact")} />
          </div>
          <div className={cx("row", "rowUser")}>
            <div className={cx("bubble", "bubbleUser")} />
          </div>
          <div className={styles.row}>
            <div className={cx("bubble", isSide && "bubbleCompact")} />
          </div>
        </div>
      </div>

      <div className={styles.inputDock}>
        <div className={cx("inputDockInner", isSide && "inputDockInnerSide")}>
          {composer ?? (
            <div className={styles.composer}>
              <div className={styles.composerLine} />
              <div className={styles.composerControls}>
                <div className={styles.composerPill} />
                <div className={styles.composerButton} />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export { ChatConversationSkeleton }
