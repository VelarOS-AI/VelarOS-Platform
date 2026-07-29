/**
 * 网格布局容器。
 *
 * variants（封闭枚举，全仓共用一套）：`gap` = `none | xs | sm | md | lg | xl`；`align` = `start | center | end | stretch`；`justify` = `start | center | end | between`；`inline` = `false | true`。
 * 样式：`.velar-grid` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const gridVariants = cva('velar-grid', {
  variants: {
    gap: {
      none: 'velar-grid-gap-none',
      xs: 'velar-grid-gap-xs',
      sm: 'velar-grid-gap-sm',
      md: 'velar-grid-gap-md',
      lg: 'velar-grid-gap-lg',
      xl: 'velar-grid-gap-xl',
    },
    align: {
      start: 'velar-grid-align-start',
      center: 'velar-grid-align-center',
      end: 'velar-grid-align-end',
      stretch: 'velar-grid-align-stretch',
    },
    justify: {
      start: 'velar-grid-justify-start',
      center: 'velar-grid-justify-center',
      end: 'velar-grid-justify-end',
      between: 'velar-grid-justify-between',
    },
    inline: {
      false: '',
      true: 'velar-grid-inline-grid',
    },
  },
  defaultVariants: {
    gap: 'md',
    align: 'stretch',
    justify: 'start',
    inline: false,
  },
})

export interface GridProps extends React.ComponentProps<'div'>, VariantProps<typeof gridVariants> {
  /** 未设置最小子项宽度时使用等宽列。 */
  columns?: number
  /** Responsive-friendly `repeat(auto-fill, minmax(...))` when set. */
  minChildWidth?: string
}

export const Grid = memo(
  ({
    className,
    gap,
    align,
    justify,
    inline,
    columns = 2,
    minChildWidth,
    style,
    ...props
  }: GridProps): React.ReactElement => {
    const template = minChildWidth
      ? `repeat(auto-fill, minmax(${minChildWidth}, 1fr))`
      : `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`

    return (
      <div
        data-slot="grid"
        className={cn(gridVariants({ gap, align, justify, inline }), className)}
        style={{
          gridTemplateColumns: template,
          ...style,
        }}
        {...props}
      />
    )
  }
)

Grid.displayName = 'Grid'
