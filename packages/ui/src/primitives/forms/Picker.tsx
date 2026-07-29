/**
 * 通用弹层选择器（触发 + 浮层列表）。
 *
 * variants（封闭枚举，全仓共用一套）：`size` = `sm | md`；`side` = `top | bottom`。
 * 样式：`.velar-picker` · 见 styles/components/。
 */
import React, { memo, useMemo, useRef } from 'react'
import { CaretDownIcon,CheckIcon } from '@phosphor-icons/react'
import { useBoolean, useClickAway } from 'ahooks'
import { cva,type VariantProps } from 'class-variance-authority'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { List } from '@velaros-ai/ui/primitives/layout/List'
import { Panel } from '@velaros-ai/ui/primitives/layout/Panel'

import { cn } from '../../lib/cn'

const pickerVariants = cva('velar-picker', {
  variants: {
    size: {
      sm: 'velar-picker-size-sm',
      md: 'velar-picker-size-md',
    },
    side: {
      top: 'velar-picker-side-top',
      bottom: 'velar-picker-side-bottom',
    },
  },
  defaultVariants: {
    size: 'sm',
    side: 'top',
  },
})

export interface PickerOption {
  value: string
  label: string
}

export interface PickerProps extends VariantProps<typeof pickerVariants> {
  value: string
  options: PickerOption[]
  title?: string
  icon?: React.ReactNode
  disabled?: boolean
  onChange: (value: string) => void
}

export const Picker = memo(
  ({
    value,
    options,
    title,
    icon,
    disabled = false,
    onChange,
    size,
    side,
  }: PickerProps): React.ReactElement => {
    const rootRef = useRef<HTMLDivElement>(null)
    const [isOpen, { setFalse, toggle }] = useBoolean(false)

    useClickAway(() => {
      setFalse()
    }, rootRef)

    const selectedOption = useMemo(
      () => options.find((option) => option.value === value) ?? { value, label: value },
      [options, value],
    )

    const canOpen = !!options.length && !disabled

    return (
      <div ref={rootRef} className={cn(pickerVariants({ size, side }))} data-slot="picker">
        <Button
          variant="ghost"
          size="sm"
          className={cn('velar-picker-trigger', disabled && 'velar-picker-disabled')}
          disabled={!canOpen}
          onClick={toggle}
          title={title ?? selectedOption.label}
        >
          {!!icon && <span className="velar-picker-trigger-icon">{icon}</span>}
          <span className="velar-picker-trigger-label">{selectedOption.label}</span>
          <CaretDownIcon
            size={14}
            className={cn('velar-picker-caret', isOpen && 'velar-picker-caret-open')}
          />
        </Button>

        {isOpen && (
          <Panel variant="strong" className="velar-picker-dropdown">
            {!!title && <div className="velar-picker-dropdown-title">{title}</div>}
            <div className="velar-picker-option-list">
              <List
                items={options}
                keyExtractor={(option) => option.value}
                wrapper="fragment"
                renderItem={(option) => {
                  const isSelected = option.value === value

                  return (
                    <Button
                      key={option.value}
                      variant="ghost"
                      size="sm"
                      className={cn(
                        'velar-picker-option-button',
                        isSelected && 'velar-picker-option-selected',
                      )}
                      onClick={() => {
                        onChange(option.value)
                        setFalse()
                      }}
                    >
                      <span className="velar-picker-option-label">{option.label}</span>
                      {isSelected && (
                        <CheckIcon size={16} weight="bold" className="velar-picker-option-check" />
                      )}
                    </Button>
                  )
                }}
              />
            </div>
          </Panel>
        )}
      </div>
    )
  },
)

Picker.displayName = 'Picker'
