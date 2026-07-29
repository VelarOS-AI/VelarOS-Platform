import { type CSSProperties, type ReactElement, useId } from 'react'

import styles from './ChatInput.module.css'

export interface ComposerTierSliderOption<T extends string> {
  value: T
  label: string
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
            onClick={() => handleSelect(index)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
