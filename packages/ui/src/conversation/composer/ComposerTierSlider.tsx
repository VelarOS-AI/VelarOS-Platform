import { type CSSProperties, type ReactElement, useId } from 'react'

import styles from './ChatInput.module.css'

export interface ComposerTierSliderOption<T extends string> {
  value: T
  label: string
  /**
   * 档位说明（落在刻度的原生 title 上）。
   *
   * 动态档位的说明由适配器提供（外部引擎逐档上报，如 codex 的 `supportedReasoningEfforts`），
   * 此前一格都没渲染——声明方写了每一档是什么意思，界面上一个字都看不到。
   */
  description?: string
}

export interface ComposerTierSliderProps<T extends string> {
  value: T
  options: Array<ComposerTierSliderOption<T>>
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel?: string
}

export function ComposerTierSlider<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: ComposerTierSliderProps<T>): ReactElement {
  const id = useId()
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )
  const max = Math.max(0, options.length - 1)
  const progress = max === 0 ? 0 : activeIndex / max

  const handleSelect = (index: number): void => {
    if (disabled) return
    const next = options[index]
    if (next && next.value !== value) onChange(next.value)
  }

  return (
    <div
      className={styles.composerTierSlider}
      data-disabled={disabled ? 'true' : undefined}
      style={{ '--tier-progress': progress } as CSSProperties}
    >
      <input
        type="range"
        className={styles.composerTierSliderInput}
        min={0}
        max={max}
        step={1}
        value={activeIndex}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={options[activeIndex]?.label}
        onChange={(event) => handleSelect(Number(event.target.value))}
      />
      <div className={styles.composerTierSliderTicks} aria-hidden="true">
        {options.map((option, index) => (
          <button
            key={`${id}-${option.value}`}
            type="button"
            className={
              index === activeIndex
                ? styles.composerTierSliderTickActive
                : styles.composerTierSliderTick
            }
            disabled={disabled}
            tabIndex={-1}
            title={option.description}
            onClick={() => handleSelect(index)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
