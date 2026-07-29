/**
 * 间距容器，按尺寸插入统一空隙。
 *
 * variants（封闭枚举，全仓共用一套）：`direction` = `horizontal | vertical`；`size` = `none | xs | sm | md | lg | xl`。
 * 样式：`.velar-space` · 见 styles/components/。
 */
import React, { Children, memo } from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
import { isPresent } from '../../lib/runtime'
const spaceVariants = cva('velar-space', {
  variants: {
    direction: {
      horizontal: 'velar-space-horizontal',
      vertical: 'velar-space-vertical',
    },
    size: {
      none: 'velar-space-gap-none',
      xs: 'velar-space-gap-xs',
      sm: 'velar-space-gap-sm',
      md: 'velar-space-gap-md',
      lg: 'velar-space-gap-lg',
      xl: 'velar-space-gap-xl',
    },
  },
  defaultVariants: {
    direction: 'horizontal',
    size: 'sm',
  },
})

export interface SpaceProps extends React.ComponentProps<'div'>, VariantProps<typeof spaceVariants> {
  /** 插入到每个子元素之间的分隔内容。 */
  split?: React.ReactNode
  wrap?: boolean
}

export const Space = memo(
  ({
    className,
    direction,
    size,
    split,
    wrap = false,
    children,
    ...props
  }: SpaceProps): React.ReactElement => {
    const items = Children.toArray(children).filter((c) => isPresent(c))

    return (
      <div
        data-slot="space"
        className={cn(spaceVariants({ direction, size }), wrap && 'velar-space-wrap', className)}
        {...props}
      >
        {items.flatMap((child, index) => {
          const nodes: React.ReactNode[] = [
            <span key={`space-item-${index}`} className={'velar-space-item'}>
              {child}
            </span>,
          ]
          if (isPresent(split) && index < items.length - 1) {
            nodes.push(
              <span key={`space-split-${index}`} className={'velar-space-split'} aria-hidden>
                {split}
              </span>
            )
          }
          return nodes
        })}
      </div>
    )
  }
)

Space.displayName = 'Space'
