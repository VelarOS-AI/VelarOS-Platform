/**
 * 列表容器原语。
 */
import React, { memo } from 'react'

interface ListProps<T> {
  items: T[]
  keyExtractor: (item: T) => string
  renderItem: (item: T) => React.ReactNode
  className?: string
  wrapper?: 'div' | 'fragment'
}

const ListInner = <T,>({
  items,
  keyExtractor,
  renderItem,
  className,
  wrapper = 'div',
}: ListProps<T>): React.ReactElement => (
  wrapper === 'fragment'
    ? (
        <>
          {items.map((item) => (
            <React.Fragment key={keyExtractor(item)}>
              {renderItem(item)}
            </React.Fragment>
          ))}
        </>
      )
    : (
        <div className={className}>
          {items.map((item) => (
            <React.Fragment key={keyExtractor(item)}>
              {renderItem(item)}
            </React.Fragment>
          ))}
        </div>
      )
)

export const List = memo(ListInner) as typeof ListInner
