import { AtIcon, TrashIcon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { StyleUtils } from '@velaros-ai/ui'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import type { UseComposerMentionMenuReturn } from './hooks/useComposerMentionMenu'

import styles from './ComposerMentionMenu.module.css'

const cx = StyleUtils.bindCx(styles)

interface ComposerMentionMenuProps {
  menu: UseComposerMentionMenuReturn
  header: string
  deleteLabel: string
}

/**
 * 聊天输入 `@` 弹出的**可引用项**列表（内联在 composer 顶部，随查询过滤，可就地移除/切换选中）。
 *
 * 表头与移除按钮文案由调用方注入（`header` / `deleteLabel`）：来源不同说法就不同
 * （工作台是"评论"，游戏空间是"选中实体"），菜单本身不替任何来源起名字。
 */
export function ComposerMentionMenu({
  menu,
  header,
  deleteLabel,
}: ComposerMentionMenuProps): Nullable<ReactElement> {
  if (!menu.open) return null

  return (
    <div className={styles.panel} role="listbox" aria-label={header}>
      <div className={styles.header}>{header}</div>
      <div className={styles.list}>
        {menu.items.map((option, index) => {
          const isSelected = menu.selectedIdSet.has(option.id)
          return (
            <div
              key={option.id}
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
              onClick={() => menu.selectItem(option.id)}
            >
              <span className={styles.itemIcon}>
                <AtIcon size={14} weight={isSelected ? 'bold' : 'regular'} />
              </span>
              <span className={styles.itemMain}>
                <Text className={styles.itemLabel}>{option.label}</Text>
                {!!option.body && (
                  <Text className={styles.itemDescription}>{option.body}</Text>
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
                  menu.deleteItem(option.id)
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
