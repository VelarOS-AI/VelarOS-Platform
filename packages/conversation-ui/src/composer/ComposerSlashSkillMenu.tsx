import { FileCodeIcon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { StyleUtils } from '@velaros-ai/ui'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { useConversationI18n } from '../i18n'

import type { UseComposerSlashSkillMenuReturn } from './hooks/useComposerSlashSkillMenu'

import styles from './ComposerSlashSkillMenu.module.css'

const cx = StyleUtils.bindCx(styles)

interface ComposerSlashSkillMenuProps {
  menu: UseComposerSlashSkillMenuReturn
  header: string
}

/** 聊天输入 / 弹出的已装技能列表（内联在 composer 顶部，随查询过滤）。 */
export function ComposerSlashSkillMenu({
  menu,
  header,
}: ComposerSlashSkillMenuProps): Nullable<ReactElement> {
  const { t } = useConversationI18n()

  if (!menu.open) return null

  return (
    <div className={styles.panel} role="listbox" aria-label={header} aria-multiselectable="true">
      <div className={styles.header}>{header}</div>
      <div className={styles.list}>
        {menu.items.map((skill, index) => {
          const highlighted = index === menu.highlightedIndex
          const selected = menu.isItemSelected(skill.id)
          const className = cx('item', highlighted && 'itemHighlighted', selected && 'itemSelected')

          return (
            <button
              key={skill.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={className}
              onMouseDown={(event) => {
                // 防止 textarea 失焦导致选择前菜单状态变化。
                event.preventDefault()
              }}
              onClick={() => menu.selectItem(skill.id)}
            >
              <span className={styles.itemIcon}>
                <FileCodeIcon size={14} weight="fill" />
              </span>
              <span className={styles.itemMain}>
                <span className={styles.itemTitleRow}>
                  <span className={styles.itemTitlePrimary}>
                    <Text className={styles.itemLabel}>{skill.label}</Text>
                    {!!skill.builtIn && (
                      <span className={styles.itemBuiltInBadge}>
                        {t('chat.composerSkillBuiltInBadge')}
                      </span>
                    )}
                  </span>
                  <span className={styles.itemSlug}>/{skill.id}</span>
                </span>
                {!!skill.description && (
                  <Text className={styles.itemDescription}>{skill.description}</Text>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
