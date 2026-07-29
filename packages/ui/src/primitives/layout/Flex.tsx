/**
 * Flex 布局容器，按 props 表达方向 / 对齐 / 间距。
 *
 * variants（封闭枚举，全仓共用一套）：`direction` = `row | column`；`gap` = `none | xs | sm | md | lg | xl`；`align` = `start | center | end | stretch | baseline`；`justify` = `start | center | end | between | around | evenly`；`wrap` = `nowrap | wrap | reverse`；`inline` = `false | true`。
 * 样式：`.velar-flex` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const flexVariants = cva('velar-flex', {
  variants: {
    direction: {
      row: 'velar-flex-row',
      column: 'velar-flex-column',
    },
    gap: {
      none: 'velar-flex-gap-none',
      xs: 'velar-flex-gap-xs',
      sm: 'velar-flex-gap-sm',
      md: 'velar-flex-gap-md',
      lg: 'velar-flex-gap-lg',
      xl: 'velar-flex-gap-xl',
    },
    align: {
      start: 'velar-flex-align-start',
      center: 'velar-flex-align-center',
      end: 'velar-flex-align-end',
      stretch: 'velar-flex-align-stretch',
      baseline: 'velar-flex-align-baseline',
    },
    justify: {
      start: 'velar-flex-justify-start',
      center: 'velar-flex-justify-center',
      end: 'velar-flex-justify-end',
      between: 'velar-flex-justify-between',
      around: 'velar-flex-justify-around',
      evenly: 'velar-flex-justify-evenly',
    },
    wrap: {
      nowrap: 'velar-flex-wrap-nowrap',
      wrap: 'velar-flex-wrap-wrap',
      reverse: 'velar-flex-wrap-reverse',
    },
    inline: {
      false: '',
      true: 'velar-flex-inline-flex',
    },
  },
  defaultVariants: {
    direction: 'row',
    gap: 'md',
    align: 'stretch',
    justify: 'start',
    wrap: 'nowrap',
    inline: false,
  },
})

export interface FlexProps
  extends Omit<React.ComponentProps<'div'>, 'wrap'>,
    Omit<VariantProps<typeof flexVariants>, 'direction' | 'wrap'> {
  /** antd-style shortcut for `direction="column"` */
  vertical?: boolean
  direction?: 'row' | 'column'
  wrap?: 'nowrap' | 'wrap' | 'reverse'
  asChild?: boolean
  inline?: boolean
}

export const Flex = memo(
  ({
    className,
    vertical = false,
    direction = 'row',
    gap,
    align,
    justify,
    wrap,
    inline,
    asChild = false,
    ...props
  }: FlexProps): React.ReactElement => {
    const Comp = asChild ? Slot : 'div'
    const resolvedDirection = vertical ? 'column' : direction

    return (
      <Comp
        data-slot="flex"
        className={cn(
          flexVariants({ direction: resolvedDirection, gap, align, justify, wrap, inline }),
          className
        )}
        {...props}
      />
    )
  }
)

Flex.displayName = 'Flex'
