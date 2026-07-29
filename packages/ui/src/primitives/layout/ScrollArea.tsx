/**
 * 自定义滚动区域，统一滚动条样式。
 *
 * variants（封闭枚举，全仓共用一套）：`axis` = `y | x | both`。
 * 样式：`.velar-scroll-area` · 见 styles/components/。
 */
import React, { forwardRef, memo } from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const scrollAreaVariants = cva('velar-scroll-area', {
  variants: {
    axis: {
      y: 'velar-scroll-area-axis-y',
      x: 'velar-scroll-area-axis-x',
      both: 'velar-scroll-area-axis-both',
    },
  },
  defaultVariants: {
    axis: 'y',
  },
})

export interface ScrollAreaProps
  extends React.ComponentProps<'div'>,
    VariantProps<typeof scrollAreaVariants> {}

const ScrollAreaInner = forwardRef<HTMLDivElement, ScrollAreaProps>(({
  className,
  axis,
  ...props
}, ref): React.ReactElement => (
  <div
    ref={ref}
    data-slot="scroll-area"
    className={cn(scrollAreaVariants({ axis }), className)}
    {...props}
  />
))

ScrollAreaInner.displayName = 'ScrollAreaInner'

export const ScrollArea = memo(ScrollAreaInner)

ScrollArea.displayName = 'ScrollArea'
