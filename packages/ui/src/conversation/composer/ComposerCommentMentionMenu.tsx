import { ChatCircleDotsIcon, TrashIcon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { StyleUtils } from '@velaros-ai/ui'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import type { UseComposerCommentMentionMenuReturn } from './hooks/useComposerCommentMentionMenu'

import styles from './ComposerCommentMentionMenu.module.css'

const cx = StyleUtils.bindCx(styles)

interface ComposerCommentMentionMenuProps {
  menu: UseComposerCommentMentionMenuReturn
  header: string
  deleteLabel: string
}

/** 聊天输入 `@` 弹出的行内评论列表（内联在 composer 顶部，随查询过滤，可就地删除/切换选中）。 */
export function ComposerCommentMentionMenu({
  menu,
  header,
  deleteLabel,
}: ComposerCommentMentionMenuProps): ReactElement | null {
  if (!menu.open) return null

  return (
    <div className={styles.panel} role="listbox" aria-label={header}>
      <div className={styles.header}>{header}</div>
      <div className={styles.list}>
        {menu.items.map((comment, index) => {
          const isSelected = menu.selectedIdSet.has(comment.id)
          return (
            <div
              key={comment.id}
              role="option"
              aria-selected={index === menu.highlightedIndex}
              tabIndex={-1}
              className={cx(
                'item',
                index === menu.highlightedIndex && 'itemHighlighted',
                isSelected && 'itemSelected'
              )}
              onMouseEnter={() => menu.setHighlightedIndex(index)}
              onMouseDown={(event) => {
                // 防止 textarea 失焦导致选择前菜单状态变化。
                event.preventDefault()
              }}
              onClick={() => menu.selectItem(comment.id)}
            >
              <span className={styles.itemIcon}>
                <ChatCircleDotsIcon size={14} weight={isSelected ? 'fill' : 'regular'} />
              </span>
              <span className={styles.itemMain}>
                <Text className={styles.itemLabel}>{comment.label}</Text>
                {!!comment.body && (
                  <Text className={styles.itemDescription}>{comment.body}</Text>
                )}
              </span>
              <button
                type="button"
                className={styles.deleteButton}
                title={deleteLabel}
                aria-label={deleteLabel}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  menu.deleteItem(comment.id)
                }}
              >
                <TrashIcon size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
