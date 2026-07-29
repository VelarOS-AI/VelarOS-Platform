/**
 * 时间选择器。
 *
 * 样式：`.velar-time-picker-option` · 见 styles/components/。
 */
import { type ComponentPropsWithoutRef, forwardRef, memo, type ReactElement, useState } from 'react'
import { ClockIcon } from '@phosphor-icons/react'

import { useUiLocalization } from '../../i18n/UiLocalizationProvider'
import { cn } from '../../lib/cn'
import { Popover, PopoverAnchor, PopoverContent } from '../overlays/Popover'

export interface TimePickerProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'disabled' | 'onChange' | 'type' | 'value'
> {
  disabled?: boolean
  onChange: (value: string) => void
  placeholder?: string
  size?: 'default' | 'sm'
  value?: string
  variant?: 'default' | 'ghost'
}

const HourValues = Array.from({ length: 24 }, (_entry, index) => String(index).padStart(2, '0'))
const MinuteValues = Array.from({ length: 60 }, (_entry, index) => String(index).padStart(2, '0'))
const TimeValuePattern = /^(?<hour>\d{2}):(?<minute>\d{2})$/u

function getTimeParts(value: LooseOptional<string>): { hour: string; minute: string } {
  const match = value?.match(TimeValuePattern)
  const hour = match?.groups?.hour
  const minute = match?.groups?.minute

  return {
    hour: HourValues.includes(hour ?? '') ? (hour as string) : '00',
    minute: MinuteValues.includes(minute ?? '') ? (minute as string) : '00',
  }
}

export const TimePicker = memo(
  forwardRef<HTMLButtonElement, TimePickerProps>(function TimePicker(
    {
      className,
      disabled = false,
      onChange,
      placeholder = '--:--',
      size = 'default',
      value = '',
      variant = 'default',
      ...props
    },
    ref
  ): ReactElement {
    const localization = useUiLocalization()
    const [open, setOpen] = useState(false)
    const timeParts = getTimeParts(value)
    const displayValue = value.trim() || placeholder

    const handleHourChange = (hour: string): void => {
      onChange(`${hour}:${timeParts.minute}`)
    }

    const handleMinuteChange = (minute: string): void => {
      onChange(`${timeParts.hour}:${minute}`)
    }

    const renderOption = (kind: 'hour' | 'minute', optionValue: string): ReactElement => {
      const selected =
        kind === 'hour' ? optionValue === timeParts.hour : optionValue === timeParts.minute
      const label =
        kind === 'hour'
          ? localization.hourOption(optionValue)
          : localization.minuteOption(optionValue)

      return (
        <button
          key={optionValue}
          type="button"
          role="option"
          aria-label={label}
          aria-selected={selected}
          className={cn(
            'velar-time-picker-option',
            selected && 'velar-time-picker-option-selected'
          )}
          onClick={() => {
            if (kind === 'hour') {
              handleHourChange(optionValue)
              return
            }

            handleMinuteChange(optionValue)
          }}
        >
          {optionValue}
        </button>
      )
    }

    return (
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (!disabled) setOpen(nextOpen)
        }}
      >
        <PopoverAnchor asChild>
          <button
            ref={ref}
            type="button"
            className={cn(
              'velar-time-picker-root',
              `velar-time-picker-size-${size}`,
              `velar-time-picker-variant-${variant}`,
              !value.trim() && 'velar-time-picker-placeholder',
              className
            )}
            data-open={open}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            {...props}
          >
            <span className="velar-time-picker-trigger">{displayValue}</span>
            <ClockIcon className="velar-time-picker-icon" aria-hidden size={15} />
          </button>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="velar-time-picker-popover"
          widthStrategy="anchor"
        >
          <div className="velar-time-picker-panel" aria-label={localization.chooseTime}>
            <div className="velar-time-picker-column" role="listbox" aria-label={localization.hour}>
              {HourValues.map((hour) => renderOption('hour', hour))}
            </div>
            <div
              className="velar-time-picker-column"
              role="listbox"
              aria-label={localization.minute}
            >
              {MinuteValues.map((minute) => renderOption('minute', minute))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    )
  })
)

TimePicker.displayName = 'TimePicker'
