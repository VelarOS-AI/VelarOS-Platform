/**
 * 数值输入，带步进与范围约束。
 *
 * 样式：`.velar-number-input-field` · 见 styles/components/。
 */
import { memo, type ReactElement,useCallback, useEffect, useMemo, useState } from 'react'
import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Input, type InputProps } from '@velaros-ai/ui/primitives/forms/Input'

import { cn } from '../../lib/cn'
import { isBlank } from '../../lib/runtime'
function clampValue(value: number, min: number, max: number, integer: boolean): number {
  const normalized = integer ? Math.round(value) : value
  return Math.min(max, Math.max(min, normalized))
}

export interface NumberInputProps
  extends Omit<
    InputProps,
    'type' | 'value' | 'defaultValue' | 'min' | 'max' | 'step' | 'onChange' | 'variant'
  > {
  value: number
  min: number
  max: number
  step?: number
  /** 仅允许整数（默认 true）。为 true 时输入框拒绝小数点，提交时四舍五入。 */
  integer?: boolean
  onChange: (value: number) => void
  /**
   * 展示形态：
   * - `stepper`（默认）：右侧带上/下箭头步进按钮的组合控件。
   * - `plain`：纯输入框，沿用 {@link Input} 的主题配色，无步进箭头。
   */
  variant?: 'stepper' | 'plain'
  /** 递减控制图标按钮的标签和无障碍标签。 */
  decrementLabel?: string
  /** 递增控制图标按钮的标签和无障碍标签。 */
  incrementLabel?: string
}

export const NumberInput = memo(
  ({
    value,
    min,
    max,
    step = 1,
    integer = true,
    variant = 'stepper',
    onChange,
    decrementLabel = 'Decrease value',
    incrementLabel = 'Increase value',
    onBlur,
    onKeyDown,
    inputMode,
    className,
    disabled,
    size = 'default',
    ...inputProps
  }: NumberInputProps): ReactElement => {
    const [draft, setDraft] = useState(String(value))

    useEffect(() => {
      setDraft(String(value))
    }, [value])

    // 合法草稿的字符集：可选负号（min<0 时）、数字，非整数时允许一个小数点。
    // 允许 "-"、"1."、".5" 等输入中间态，便于继续键入；非法字符直接拒绝（含粘贴）。
    const draftPattern = useMemo(() => {
      const sign = min < 0 ? '-?' : ''
      return integer ? new RegExp(`^${sign}\\d*$`) : new RegExp(`^${sign}\\d*\\.?\\d*$`)
    }, [integer, min])

    const commitValue = useCallback(
      (raw: string): void => {
        if (isBlank(raw.trim())) {
          setDraft(String(value))
          return
        }

        const parsed = +raw
        if (!Number.isFinite(parsed)) {
          setDraft(String(value))
          return
        }

        const normalized = clampValue(parsed, min, max, integer)
        setDraft(String(normalized))

        if (normalized !== value) {
          onChange(normalized)
        }
      },
      [integer, max, min, onChange, value],
    )

    const canDecrement = useMemo(
      () => clampValue(value - step, min, max, integer) !== value,
      [integer, max, min, step, value],
    )

    const canIncrement = useMemo(
      () => clampValue(value + step, min, max, integer) !== value,
      [integer, max, min, step, value],
    )

    const bump = useCallback(
      (delta: number): void => {
        const next = clampValue(value + delta, min, max, integer)
        if (next !== value) {
          onChange(next)
        }
      },
      [integer, max, min, onChange, value],
    )

    const sizeKey = size === 'sm' ? 'sm' : 'default'

    const inputField = (
      <Input
        {...inputProps}
        type="text"
        inputMode={inputMode ?? (integer ? 'numeric' : 'decimal')}
        autoComplete="off"
        spellCheck={false}
        size={size}
        disabled={disabled}
        className={variant === 'plain' ? className : 'velar-number-input-field'}
        value={draft}
        onChange={(event) => {
          const nextDraft = event.target.value
          // 拒绝非数字字符（含粘贴）：非空且不匹配字符集时不更新草稿。
          if (!isBlank(nextDraft) && !draftPattern.test(nextDraft)) return
          setDraft(nextDraft)

          if (isBlank(nextDraft.trim())) return

          const parsed = +nextDraft
          if (!Number.isFinite(parsed)) return

          const normalized = clampValue(parsed, min, max, integer)
          if (normalized !== value) {
            onChange(normalized)
          }
        }}
        onBlur={(event) => {
          commitValue(event.target.value)
          onBlur?.(event)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commitValue((event.target as HTMLInputElement).value)
          }

          onKeyDown?.(event)
        }}
      />
    )

    if (variant === 'plain') return inputField

    return (
      <div
        className={cn('velar-number-input', className)}
        data-slot="number-input"
        data-size={sizeKey}
      >
        {inputField}

        <div className="velar-number-input-spin" role="group">
          <IconButton
            label={incrementLabel}
            variant="ghost"
            size="icon-sm"
            disabled={disabled || !canIncrement}
            className={cn('velar-number-input-step', 'velar-number-input-step-up')}
            onClick={() => bump(step)}
          >
            <CaretUpIcon size={14} weight="bold" />
          </IconButton>
          <IconButton
            label={decrementLabel}
            variant="ghost"
            size="icon-sm"
            disabled={disabled || !canDecrement}
            className={cn('velar-number-input-step', 'velar-number-input-step-down')}
            onClick={() => bump(-step)}
          >
            <CaretDownIcon size={14} weight="bold" />
          </IconButton>
        </div>
      </div>
    )
  },
)

NumberInput.displayName = 'NumberInput'
