/**
 * 开关，持久二元状态切换。
 *
 * variants（封闭枚举，全仓共用一套）：`tone` = `default | neutral`；`size` = `md | sm | xs`。
 * 样式：`.velar-switch` · 见 styles/components/。
 */
import React, { memo } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const switchVariants = cva('velar-switch', {
  variants: {
    tone: {
      default: 'velar-switch-tone-default',
      neutral: 'velar-switch-tone-neutral',
    },
    size: {
      md: 'velar-switch-size-md',
      sm: 'velar-switch-size-sm',
      xs: 'velar-switch-size-xs',
    },
  },
  defaultVariants: {
    tone: 'default',
    size: 'sm',
  },
})

/**
 * `checked` 必填 = **只做受控**；`defaultChecked` 一并 Omit，否则会经 `{...props}` 透给
 * Radix Root，与 `checked` 同时存在形成受控/非受控双态。判据同 Checkbox。
 */
export interface SwitchProps
  extends Omit<
      React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>,
      'onCheckedChange' | 'defaultChecked'
    >,
    VariantProps<typeof switchVariants> {
  checked: boolean
  onCheckedChange?: (checked: boolean) => void
}

export const Switch = memo(({
  checked,
  tone,
  size,
  className,
  onCheckedChange,
  ...props
}: SwitchProps): React.ReactElement => (
  <SwitchPrimitive.Root
    checked={checked}
    data-slot="switch"
    className={cn(switchVariants({ tone, size }), className)}
    onCheckedChange={onCheckedChange}
    {...props}
  >
    <SwitchPrimitive.Thumb className={'velar-switch-thumb'} />
  </SwitchPrimitive.Root>
))

Switch.displayName = 'Switch'
