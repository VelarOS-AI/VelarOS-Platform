/**
 * 单选组，互斥选项。
 *
 * variants（封闭枚举，全仓共用一套）：`size` = `default | sm`；`orientation` = `horizontal | vertical`。
 * 样式：`.velar-radio-radio` · 见 styles/components/。
 */
import React, {
  createContext,
  type InputHTMLAttributes,
  memo,
  type ReactElement,
  useContext,
  useId,
} from 'react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const radioVariants = cva('velar-radio-radio', {
  variants: {
    size: {
      default: 'velar-radio-size-default',
      sm: 'velar-radio-size-sm',
    },
  },
  defaultVariants: {
    size: 'default',
  },
})

interface RadioGroupContextValue {
  value: string
  onValueChange: (next: string) => void
  name: string
  disabled?: boolean
}

const RadioGroupContext = createContext<Nullable<RadioGroupContextValue>>(null)

function useRadioGroupContext(): RadioGroupContextValue {
  const ctx = useContext(RadioGroupContext)
  if (!ctx) {
    throw new Error('Radio must be used inside RadioGroup')
  }
  return ctx
}

const groupVariants = cva('velar-radio-group', {
  variants: {
    orientation: {
      horizontal: 'velar-radio-horizontal',
      vertical: 'velar-radio-vertical',
    },
  },
  defaultVariants: {
    orientation: 'vertical',
  },
})

export interface RadioGroupProps
  extends React.ComponentProps<'div'>,
    VariantProps<typeof groupVariants> {
  value: string
  onValueChange: (value: string) => void
  /** 覆盖原生单选组自动生成的名称。 */
  name?: string
  disabled?: boolean
}

export const RadioGroup = memo(
  ({
    className,
    orientation,
    value,
    onValueChange,
    name: nameProp,
    disabled = false,
    children,
    ...props
  }: RadioGroupProps): ReactElement => {
    const id = useId()
    const name = nameProp ?? `radio-group-${id}`
    const store: RadioGroupContextValue = {
      value,
      onValueChange,
      name,
      disabled,
    }

    return (
      <RadioGroupContext.Provider value={store}>
        <div
          data-slot="radio-group"
          role="radiogroup"
          className={cn(groupVariants({ orientation }), className)}
          {...props}
        >
          {children}
        </div>
      </RadioGroupContext.Provider>
    )
  }
)

RadioGroup.displayName = 'RadioGroup'

export interface RadioProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type' | 'value' | 'onChange'>,
    VariantProps<typeof radioVariants> {
  value: string
  onChange?: InputHTMLAttributes<HTMLInputElement>['onChange']
}

export const Radio = memo(
  ({
    value,
    size,
    className,
    disabled: disabledProp,
    onChange,
    ...props
  }: RadioProps): ReactElement => {
    const ctx = useRadioGroupContext()
    const disabled = !!(disabledProp || ctx.disabled)
    const checked = ctx.value === value

    return (
      <label
        data-slot="radio"
        className={cn(
          radioVariants({ size }),
          checked && 'velar-radio-checked',
          disabled && 'velar-radio-disabled',
          className
        )}
      >
        <input
          {...props}
          type="radio"
          name={ctx.name}
          value={value}
          checked={checked}
          disabled={disabled}
          className={'velar-radio-input'}
          onChange={(event) => {
            onChange?.(event)
            if (!disabled) {
              ctx.onValueChange(value)
            }
          }}
        />
        <span className={'velar-radio-dot'} aria-hidden />
      </label>
    )
  }
)

Radio.displayName = 'Radio'
