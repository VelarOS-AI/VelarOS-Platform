/**
 * 可折叠导航侧栏。
 *
 * 样式：`.velar-collapsible-nav` · 见 styles/components/。
 */
import React, { memo, useMemo, useState } from 'react'
import { CaretRightIcon } from '@phosphor-icons/react'

import { cn } from '@velaros-ai/ui/lib/cn'
export interface CollapsibleNavItem {
  id: string
  label: React.ReactNode
  description?: React.ReactNode
  count?: React.ReactNode
}

export interface CollapsibleNavGroup {
  id: string
  title: React.ReactNode
  description?: React.ReactNode
  count?: React.ReactNode
  items: CollapsibleNavItem[]
}

export interface CollapsibleNavProps extends Omit<React.ComponentPropsWithoutRef<'nav'>, 'onSelect'> {
  groups: CollapsibleNavGroup[]
  selectedItemId?: LooseOptional<string>
  defaultOpenGroupIds?: string[]
  itemLabel?: string
  onSelect?: (itemId: string) => void
}

export const CollapsibleNav = memo(
  ({
    groups,
    selectedItemId,
    defaultOpenGroupIds,
    itemLabel,
    onSelect,
    className,
    ...props
  }: CollapsibleNavProps): React.ReactElement => {
    const defaultOpenIds = useMemo(
      () => defaultOpenGroupIds ?? groups.map((group) => group.id),
      [defaultOpenGroupIds, groups]
    )
    const [openGroupIds, setOpenGroupIds] = useState<Set<string>>(
      () => new Set(defaultOpenIds)
    )

    const toggleGroup = (groupId: string): void => {
      setOpenGroupIds((previous) => {
        const next = new Set(previous)
        if (next.has(groupId)) {
          next.delete(groupId)
        } else {
          next.add(groupId)
        }

        return next
      })
    }

    return (
      <nav
        data-slot="collapsible-nav"
        aria-label={itemLabel}
        className={cn('velar-collapsible-nav', className)}
        {...props}
      >
        {groups.map((group) => {
          const isOpen = openGroupIds.has(group.id)

          return (
            <section key={group.id} className={'velar-collapsible-nav-group'}>
              <button
                type="button"
                className={'velar-collapsible-nav-group-button'}
                aria-expanded={isOpen}
                onClick={() => toggleGroup(group.id)}
              >
                <CaretRightIcon size={13} weight="bold" className={'velar-collapsible-nav-group-caret'} />
                <span className={'velar-collapsible-nav-group-copy'}>
                  <span className={'velar-collapsible-nav-group-title'}>{group.title}</span>
                  {!!group.description && (
                    <span className={'velar-collapsible-nav-group-description'}>{group.description}</span>
                  )}
                </span>
                {!!group.count && <span className={'velar-collapsible-nav-group-count'}>{group.count}</span>}
              </button>

              {isOpen && (
                <div className={'velar-collapsible-nav-item-list'}>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={'velar-collapsible-nav-item-button'}
                      data-selected={selectedItemId === item.id}
                      onClick={() => onSelect?.(item.id)}
                    >
                      <span className={'velar-collapsible-nav-item-copy'}>
                        <span className={'velar-collapsible-nav-item-label'}>{item.label}</span>
                        {!!item.description && (
                          <span className={'velar-collapsible-nav-item-description'}>{item.description}</span>
                        )}
                      </span>
                      {!!item.count && <span className={'velar-collapsible-nav-item-count'}>{item.count}</span>}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </nav>
    )
  }
)

CollapsibleNav.displayName = 'CollapsibleNav'
