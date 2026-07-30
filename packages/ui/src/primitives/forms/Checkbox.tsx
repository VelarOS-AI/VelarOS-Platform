/**
 * 复选框，二元或不定态选择。
 *
 * variants（封闭枚举，全仓共用一套）：`size` = `default | sm`。
 * 样式：`.velar-checkbox` · 见 styles/components/。
 */
import { type InputHTMLAttributes, memo, type ReactElement,useLayoutEffect, useRef } from 'react'
import { CheckIcon } from '@phosphor-icons/react'
import { cva,type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/cn'
const checkboxVariants = cva('velar-checkbox', {
  variants: {
    size: {
      default: 'velar-checkbox-size-default',
      sm: 'velar-checkbox-size-sm',
    },
  },
  defaultVariants: {
    size: 'default',
  },
})

/**
 * `checked` 必填 = **只做受控**。`defaultChecked` 必须一并 Omit：不 Omit 时它会经
 * `{...props}` 透给原生 input，与 `checked` 同时存在——React 告警且行为未定义。
 * 「只做受控」是形态判决，不是漏了默认值。
 */
export interface CheckboxProps
  extends Omit<
      InputHTMLAttributes<HTMLInputElement>,
      'size' | 'type' | 'onChange' | 'defaultChecked'
    >,
    VariantProps<typeof checkboxVariants> {
  checked: boolean
  /** 三态表头复选框，例如表格全选。 */
  indeterminate?: boolean
  onCheckedChange?: (checked: boolean) => void
}

export const Checkbox = memo(({
  checked,
  indeterminate = false,
  size,
  className,
  disabled,
  onCheckedChange,
  ...props
}: CheckboxProps): ReactElement => {
  const inputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    const node = inputRef.current
    if (node) {
      node.indeterminate = !!indeterminate
    }
  }, [checked, indeterminate])

  return (
    <label
      data-slot="checkbox"
      className={cn(
        checkboxVariants({ size }),
        checked && 'velar-checkbox-checked',
        disabled && 'velar-checkbox-disabled',
        className,
      )}
    >
      <input
        {...props}
        ref={inputRef}
        checked={checked}
        className={'velar-checkbox-input'}
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onCheckedChange?.(event.target.checked)}
      />
      <span className={'velar-checkbox-indicator'}>
        <CheckIcon size={12} weight="bold" />
      </span>
    </label>
  )
})

Checkbox.displayName = 'Checkbox'
