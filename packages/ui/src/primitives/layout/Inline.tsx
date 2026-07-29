/**
 * 行内横向排列容器，统一间距。
 *
 * variants（封闭枚举，全仓共用一套）：`gap` = `none | xs | sm | md | lg`；`align` = `start | center | end | stretch`；`justify` = `start | center | end | between`；`wrap` = `nowrap | wrap`。
 * 样式：`.velar-inline` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const inlineVariants = cva('velar-inline', {
  variants: {
    gap: {
      none: 'velar-inline-gap-none',
      xs: 'velar-inline-gap-xs',
      sm: 'velar-inline-gap-sm',
      md: 'velar-inline-gap-md',
      lg: 'velar-inline-gap-lg',
    },
    align: {
      start: 'velar-inline-align-start',
      center: 'velar-inline-align-center',
      end: 'velar-inline-align-end',
      stretch: 'velar-inline-align-stretch',
    },
    justify: {
      start: 'velar-inline-justify-start',
      center: 'velar-inline-justify-center',
      end: 'velar-inline-justify-end',
      between: 'velar-inline-justify-between',
    },
    wrap: {
      nowrap: 'velar-inline-wrap-nowrap',
      wrap: 'velar-inline-wrap-wrap',
    },
  },
  defaultVariants: {
    gap: 'md',
    align: 'center',
    justify: 'start',
    wrap: 'nowrap',
  },
})

export interface InlineProps
  extends React.ComponentProps<'div'>,
    VariantProps<typeof inlineVariants> {
  asChild?: boolean
}

export const Inline = memo(({
  className,
  gap,
  align,
  justify,
  wrap,
  asChild = false,
  ...props
}: InlineProps): React.ReactElement => {
  const Comp = asChild ? Slot : 'div'

  return (
    <Comp
      data-slot="inline"
      className={cn(inlineVariants({ gap, align, justify, wrap }), className)}
      {...props}
    />
  )
})

Inline.displayName = 'Inline'
