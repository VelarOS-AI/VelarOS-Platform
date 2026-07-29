/**
 * 纵向堆叠容器，统一间距。
 *
 * variants（封闭枚举，全仓共用一套）：`gap` = `none | xs | sm | md | lg | xl`；`align` = `start | center | end | stretch`。
 * 样式：`.velar-stack` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const stackVariants = cva('velar-stack', {
  variants: {
    gap: {
      none: 'velar-stack-gap-none',
      xs: 'velar-stack-gap-xs',
      sm: 'velar-stack-gap-sm',
      md: 'velar-stack-gap-md',
      lg: 'velar-stack-gap-lg',
      xl: 'velar-stack-gap-xl',
    },
    align: {
      start: 'velar-stack-align-start',
      center: 'velar-stack-align-center',
      end: 'velar-stack-align-end',
      stretch: 'velar-stack-align-stretch',
    },
  },
  defaultVariants: {
    gap: 'md',
    align: 'stretch',
  },
})

export interface StackProps
  extends React.ComponentProps<'div'>,
    VariantProps<typeof stackVariants> {
  asChild?: boolean
}

export const Stack = memo(({
  className,
  gap,
  align,
  asChild = false,
  ...props
}: StackProps): React.ReactElement => {
  const Comp = asChild ? Slot : 'div'

  return (
    <Comp
      data-slot="stack"
      className={cn(stackVariants({ gap, align }), className)}
      {...props}
    />
  )
})

Stack.displayName = 'Stack'
