/**
 * 居中布局容器。
 *
 * variants（封闭枚举，全仓共用一套）：`inline` = `false | true`。
 * 样式：`.velar-center` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const centerVariants = cva('velar-center', {
  variants: {
    inline: {
      false: 'velar-center-block',
      true: 'velar-center-inline',
    },
  },
  defaultVariants: {
    inline: false,
  },
})

export interface CenterProps extends React.ComponentProps<'div'>, VariantProps<typeof centerVariants> {}

export const Center = memo(
  ({ className, inline, ...props }: CenterProps): React.ReactElement => (
    <div data-slot="center" className={cn(centerVariants({ inline }), className)} {...props} />
  )
)

Center.displayName = 'Center'
