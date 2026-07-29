/**
 * 多行文本输入。
 *
 * variants（封闭枚举，全仓共用一套）：`variant` = `default | ghost | bare`；`size` = `default | sm`。
 * 样式：`.velar-textarea` · 见 styles/components/。
 */
import React, { forwardRef, memo } from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const textareaVariants = cva('velar-textarea', {
  variants: {
    variant: {
      default: 'velar-textarea-variant-default',
      ghost: 'velar-textarea-variant-ghost',
      bare: 'velar-textarea-variant-bare',
    },
    size: {
      default: 'velar-textarea-size-default',
      sm: 'velar-textarea-size-sm',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
})

export interface TextareaProps
  extends React.ComponentProps<'textarea'>,
    VariantProps<typeof textareaVariants> {}

const TextareaInner = forwardRef<HTMLTextAreaElement, TextareaProps>(({
  className,
  variant,
  size,
  ...props
}, ref): React.ReactElement => (
  <textarea
    ref={ref}
    data-slot="textarea"
    className={cn(textareaVariants({ variant, size }), className)}
    {...props}
  />
))

TextareaInner.displayName = 'TextareaInner'

export const Textarea = memo(TextareaInner)

Textarea.displayName = 'Textarea'
