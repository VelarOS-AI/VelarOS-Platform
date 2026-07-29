/**
 * 行内文本原语，按 size / tone 统一排版。
 *
 * variants（封闭枚举，全仓共用一套）：`tone` = `default | secondary | caption | strong`；`truncate` = `false | true`。
 * 样式：`.velar-text` · 见 styles/components/。
 */
import React, { memo } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const textVariants = cva('velar-text', {
  variants: {
    tone: {
      default: 'velar-text-tone-default',
      secondary: 'velar-text-tone-secondary',
      caption: 'velar-text-tone-caption',
      strong: 'velar-text-tone-strong',
    },
    truncate: {
      false: '',
      true: 'velar-text-truncate',
    },
  },
  defaultVariants: {
    tone: 'default',
    truncate: false,
  },
})

type TextNativeProps = Omit<React.ComponentProps<'span'>, 'children'> & { children?: React.ReactNode }

export interface TextProps extends TextNativeProps, VariantProps<typeof textVariants> {
  asChild?: boolean
}

export const Text = memo(
  ({
    className,
    tone,
    truncate,
    asChild = false,
    ...props
  }: TextProps): React.ReactElement => {
    const Comp = asChild ? Slot : 'span'

    return (
      <Comp
        data-slot="text"
        className={cn(textVariants({ tone, truncate }), className)}
        {...props}
      />
    )
  }
)

Text.displayName = 'Text'
