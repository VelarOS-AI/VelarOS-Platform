/**
 * 行 / 列栅格（Row + Col）。
 *
 * variants（封闭枚举，全仓共用一套）：`gutter` = `none | xs | sm | md | lg | xl`；`align` = `top | middle | bottom | stretch`；`justify` = `start | center | end | between`。
 * 样式：`.velar-row-col-row` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const rowVariants = cva('velar-row-col-row', {
  variants: {
    gutter: {
      none: 'velar-row-col-gap-none',
      xs: 'velar-row-col-gap-xs',
      sm: 'velar-row-col-gap-sm',
      md: 'velar-row-col-gap-md',
      lg: 'velar-row-col-gap-lg',
      xl: 'velar-row-col-gap-xl',
    },
    align: {
      top: 'velar-row-col-align-top',
      middle: 'velar-row-col-align-middle',
      bottom: 'velar-row-col-align-bottom',
      stretch: 'velar-row-col-align-stretch',
    },
    justify: {
      start: 'velar-row-col-justify-start',
      center: 'velar-row-col-justify-center',
      end: 'velar-row-col-justify-end',
      between: 'velar-row-col-justify-between',
    },
  },
  defaultVariants: {
    gutter: 'md',
    align: 'top',
    justify: 'start',
  },
})

export interface RowProps extends React.ComponentProps<'div'>, VariantProps<typeof rowVariants> {}

export const Row = memo(
  ({ className, gutter, align, justify, ...props }: RowProps): React.ReactElement => (
    <div
      data-slot="row"
      className={cn(rowVariants({ gutter, align, justify }), className)}
      {...props}
    />
  )
)

Row.displayName = 'Row'

export interface ColProps extends React.ComponentProps<'div'> {
  /** 24-column grid span, antd-style */
  span?: number
}

export const Col = memo(
  ({ className, span = 24, style, ...props }: ColProps): React.ReactElement => {
    const safe = Math.min(24, Math.max(1, span))

    return (
      <div
        data-slot="col"
        className={cn('velar-row-col-col', className)}
        style={
          {
            '--velar-col-span': String(safe),
            ...style,
          } as React.CSSProperties
        }
        {...props}
      />
    )
  }
)

Col.displayName = 'Col'
