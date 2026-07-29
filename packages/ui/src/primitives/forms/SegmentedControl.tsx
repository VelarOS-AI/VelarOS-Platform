/**
 * 分段控件，卡内策略 / 模式切换（非应用级导航）。
 *
 * 样式：`.velar-segmented-control` · 见 styles/components/。
 */
import React, { memo } from 'react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'

import { cn } from '../../lib/cn'

export interface SegmentOption<T extends string> {
  value: T
  label: React.ReactNode
  disabled?: boolean
}

interface SegmentedControlProps<T extends string> {
  ariaLabel?: string
  className?: string
  value: T
  variant?: 'solid' | 'subtle'
  options: Array<SegmentOption<T>>
  onChange: (value: T) => void
}

function SegmentedControlImpl<T extends string>({
  ariaLabel,
  className,
  value,
  variant = 'solid',
  options,
  onChange,
}: SegmentedControlProps<T>): React.ReactElement {
  return (
    <div
      data-slot="segmented-control"
      role="group"
      aria-label={ariaLabel}
      className={cn('velar-segmented-control', `velar-segmented-control-${variant}`, className)}
    >
      {options.map((option) => {
        const isActive = option.value === value

        return (
          <Button
            key={option.value}
            variant="ghost"
            size="sm"
            className={cn(
              'velar-segmented-control-item',
              isActive ? 'velar-segmented-control-active' : 'velar-segmented-control-inactive'
            )}
            aria-pressed={isActive}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}

export const SegmentedControl = memo(SegmentedControlImpl) as <T extends string>(
  props: SegmentedControlProps<T>
) => React.ReactElement
;(SegmentedControl as React.NamedExoticComponent).displayName = 'SegmentedControl'
