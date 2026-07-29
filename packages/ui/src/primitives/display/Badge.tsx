/**
 * 状态 / 分类小标签，承载弱强调的标记或计数。
 *
 * variants（封闭枚举，全仓共用一套）：`variant` = `default | secondary | destructive | outline`。
 * 样式：`.velar-badge` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const badgeVariants = cva('velar-badge', {
  variants: {
    variant: {
      default: 'velar-badge-variant-default',
      secondary: 'velar-badge-variant-secondary',
      destructive: 'velar-badge-variant-destructive',
      outline: 'velar-badge-variant-outline',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
})

export interface BadgeProps
  extends React.ComponentProps<'span'>,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean
}

export const Badge = memo(
  ({ className, variant, asChild = false, ...props }: BadgeProps): React.ReactElement => {
    const Comp = asChild ? Slot : 'span'
    return (
      <Comp
        data-slot="badge"
        className={cn(badgeVariants({ variant }), className)}
        {...props}
      />
    )
  }
)

Badge.displayName = 'Badge'
