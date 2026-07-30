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

// `memo()` 吃掉泛型签名，故断言回 `typeof ListInner`（§1.4 白名单：无泛型的原生返回桥接）。
// 断言把 displayName 也一并抹掉——memo 包出来的组件在 devtools 里本就是匿名的，必须显式补挂，
// 否则整棵列表显示为 `Anonymous`。同款写法见 Select.tsx / SegmentedControl.tsx。
export const List = memo(ListInner) as typeof ListInner & { displayName?: string }
List.displayName = 'List'
