/**
 * 单行文本输入。
 *
 * variants（封闭枚举，全仓共用一套）：`variant` = `default | ghost`；`size` = `default | sm`。
 * 样式：`.velar-input` · 见 styles/components/。
 */
import React, { forwardRef, memo } from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const inputVariants = cva('velar-input', {
  variants: {
    variant: {
      default: 'velar-input-variant-default',
      ghost: 'velar-input-variant-ghost',
    },
    size: {
      default: 'velar-input-size-default',
      sm: 'velar-input-size-sm',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
})

export interface InputProps
  extends Omit<React.ComponentProps<'input'>, 'size'>,
    VariantProps<typeof inputVariants> {}

export const Input = memo(
  forwardRef<HTMLInputElement, InputProps>(function Input(
    { className, type, variant, size, ...props },
    ref
  ): React.ReactElement {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(inputVariants({ variant, size }), className)}
        {...props}
      />
    )
  })
)

Input.displayName = 'Input'
