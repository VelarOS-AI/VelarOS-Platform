/**
 * 正文段落文本，统一行高与色阶。
 *
 * variants（封闭枚举，全仓共用一套）：`tone` = `default | secondary | muted`；`spacing` = `none | sm | md | lg`。
 * 样式：`.velar-paragraph` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const paragraphVariants = cva('velar-paragraph', {
  variants: {
    tone: {
      default: 'velar-paragraph-tone-default',
      secondary: 'velar-paragraph-tone-secondary',
      muted: 'velar-paragraph-tone-muted',
    },
    spacing: {
      none: 'velar-paragraph-spacing-none',
      sm: 'velar-paragraph-spacing-sm',
      md: 'velar-paragraph-spacing-md',
      lg: 'velar-paragraph-spacing-lg',
    },
  },
  defaultVariants: {
    tone: 'default',
    spacing: 'md',
  },
})

export interface ParagraphProps
  extends React.ComponentProps<'p'>,
    VariantProps<typeof paragraphVariants> {
  asChild?: boolean
}

export const Paragraph = memo(
  ({
    className,
    tone,
    spacing,
    asChild = false,
    ...props
  }: ParagraphProps): React.ReactElement => {
    const Comp = asChild ? Slot : 'p'

    return (
      <Comp
        data-slot="paragraph"
        className={cn(paragraphVariants({ tone, spacing }), className)}
        {...props}
      />
    )
  }
)

Paragraph.displayName = 'Paragraph'
