/**
 * 空状态占位块：图标 + 标题 + 说明 + 可选动作。
 *
 * variants（封闭枚举，全仓共用一套）：`imageSize` = `sm | md | lg`。
 * 样式：`.velar-empty-image` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
import { isPresent } from '../../lib/runtime'
const emptyVariants = cva('velar-empty-image', {
  variants: {
    imageSize: {
      sm: 'velar-empty-image-sm',
      md: 'velar-empty-image-md',
      lg: 'velar-empty-image-lg',
    },
  },
  defaultVariants: {
    imageSize: 'md',
  },
})

export interface EmptyProps
  extends Omit<React.ComponentProps<'div'>, 'title'>,
    VariantProps<typeof emptyVariants> {
  image?: React.ReactNode
  title?: React.ReactNode
  description?: React.ReactNode
  /** antd-style action row */
  extra?: React.ReactNode
}

export const Empty = memo(
  ({
    className,
    imageSize,
    image,
    title,
    description,
    extra,
    children,
    ...props
  }: EmptyProps): React.ReactElement => (
    <div data-slot="empty" className={cn('velar-empty', className)} {...props}>
      {isPresent(image) && <div className={emptyVariants({ imageSize })}>{image}</div>}
      {isPresent(title) && <div className={'velar-empty-title'}>{title}</div>}
      {isPresent(description) && <div className={'velar-empty-description'}>{description}</div>}
      {(isPresent(extra) || isPresent(children)) && (
        <div className={'velar-empty-footer'}>
          {extra}
          {children}
        </div>
      )}
    </div>
  )
)

Empty.displayName = 'Empty'
