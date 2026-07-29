/**
 * 加载骨架占位，表达内容待载。
 *
 * variants（封闭枚举，全仓共用一套）：`variant` = `text | textSm | textLg | circular | rectangular | rounded`。
 * 样式：`.velar-skeleton` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
import { isNumber,isPresent, optionalWhen } from '../../lib/runtime'
const skeletonVariants = cva('velar-skeleton', {
  variants: {
    variant: {
      text: 'velar-skeleton-text',
      textSm: 'velar-skeleton-text-sm',
      textLg: 'velar-skeleton-text-lg',
      circular: 'velar-skeleton-circular',
      rectangular: 'velar-skeleton-rectangular',
      rounded: 'velar-skeleton-rounded',
    },
  },
  defaultVariants: {
    variant: 'text',
  },
})

export interface SkeletonProps extends React.ComponentProps<'div'>, VariantProps<typeof skeletonVariants> {
  /** 与高度一起设置时，跳过预设文本行高。 */
  width?: number | string
  height?: number | string
}

export const Skeleton = memo(
  ({
    className,
    variant,
    width,
    height,
    style,
    ...props
  }: SkeletonProps): React.ReactElement => {
    const w = optionalWhen((isPresent(width)), ((isNumber(width) ? `${width}px` : width)))
    const h = optionalWhen((isPresent(height)), ((isNumber(height) ? `${height}px` : height)))

    return (
      <div
        data-slot="skeleton"
        className={cn(skeletonVariants({ variant }), className)}
        style={{
          width: w,
          height: h,
          ...style,
        }}
        {...props}
      />
    )
  }
)

Skeleton.displayName = 'Skeleton'
