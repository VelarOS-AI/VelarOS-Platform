/**
 * 基础卡片容器，统一圆角 / 内距 / 边框。
 *
 * variants（封闭枚举，全仓共用一套）：`bordered` = `true | false`；`size` = `default | sm`。
 * 样式：`.velar-card` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
import { isPresent, optionalWhenLazy } from '../../lib/runtime'
const cardVariants = cva('velar-card', {
  variants: {
    bordered: {
      true: 'velar-card-bordered',
      false: 'velar-card-borderless',
    },
    size: {
      default: 'velar-card-size-default',
      sm: 'velar-card-size-sm',
    },
  },
  defaultVariants: {
    bordered: true,
    size: 'default',
  },
})

export interface CardProps
  extends Omit<React.ComponentProps<'div'>, 'title'>, VariantProps<typeof cardVariants> {
  title?: React.ReactNode
  extra?: React.ReactNode
}

export const Card = memo(
  ({
    className,
    bordered,
    size,
    title,
    extra,
    children,
    ...props
  }: CardProps): React.ReactElement => {
    const showHead = isPresent(title) || isPresent(extra)

    return (
      <div data-slot="card" className={cn(cardVariants({ bordered, size }), className)} {...props}>
        {showHead && (
          <div className={'velar-card-header'}>
            {isPresent(title) && <div className={'velar-card-title'}>{title}</div>}
            {isPresent(extra) && <div className={'velar-card-extra'}>{extra}</div>}
          </div>
        )}
        <div
          className={cn(
            'velar-card-body',
            optionalWhenLazy(!showHead, () => 'velar-card-body-no-header')
          )}
        >
          {children}
        </div>
      </div>
    )
  }
)

Card.displayName = 'Card'
