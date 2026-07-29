/**
 * 文本 / 图标+文本命令按钮，跨设置对话框、破坏性确认与顶栏次级动作复用同一套强调层级。
 *
 * variants（封闭枚举，全仓共用一套）：`variant` = `default | destructive | destructiveOutline | destructiveGhost | outline | secondary | ghost | link`；`size` = `default | sm | lg | block | icon`；`hoverBackground` = `true | false`。
 * 样式：`.velar-button` · 见 styles/components/。
 */
import React, { forwardRef, memo } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
import { isPresent } from '../../lib/runtime'
const buttonVariants = cva('velar-button', {
  variants: {
    variant: {
      default: 'velar-button-variant-default',
      destructive: 'velar-button-variant-destructive',
      destructiveOutline: 'velar-button-variant-destructive-outline',
      destructiveGhost: 'velar-button-variant-destructive-ghost',
      outline: 'velar-button-variant-outline',
      secondary: 'velar-button-variant-secondary',
      ghost: 'velar-button-variant-ghost',
      link: 'velar-button-variant-link',
    },
    size: {
      default: 'velar-button-size-default',
      sm: 'velar-button-size-sm',
      lg: 'velar-button-size-lg',
      /** 全宽列表或工具栏行；不固定高度，子元素默认单行展示。 */
      block: 'velar-button-size-block',
      icon: 'velar-button-size-icon',
      'icon-sm': 'velar-button-size-icon-sm',
      'icon-lg': 'velar-button-size-icon-lg',
    },
    hoverBackground: {
      true: null,
      false: 'velar-button-hover-background-none',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
    hoverBackground: true,
  },
})

export interface ButtonProps
  extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  active?: boolean
  asChild?: boolean
}

export const Button = memo(
  forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    {
      active = false,
      className,
      hoverBackground,
      variant,
      size,
      asChild = false,
      type,
      ...props
    },
    ref
  ): React.ReactElement {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        ref={ref}
        data-slot="button"
        data-variant={variant}
        data-size={size}
        data-active={active}
        className={cn(buttonVariants({ variant, size, hoverBackground }), className)}
        // 默认类型避免表单内隐式提交；需要提交时显式传入提交类型。
        {...(asChild ? (!isPresent(type) ? {} : { type }) : { type: type ?? 'button' })}
        {...props}
      />
    )
  })
)

Button.displayName = 'Button'
