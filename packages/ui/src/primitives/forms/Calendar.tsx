/**
 * 日历选择面板（单日 / 范围），基于 react-day-picker。
 *
 * 样式：`.velar-calendar-nav-button` · 见 styles/components/。
 */
import { memo, type ReactElement, useEffect, useState } from 'react'
import { CalendarBlankIcon, CaretDownIcon, XIcon } from '@phosphor-icons/react'
import { type DateRange, DayPicker, type DayPickerProps } from 'react-day-picker'
import { enUS, zhCN } from 'react-day-picker/locale'

import { useUiLocalization } from '../../i18n/UiLocalizationProvider'
import { cn } from '../../lib/cn'
import { isPresent,optionalWhen } from '../../lib/runtime'
import { Button } from '../buttons/Button'
import { Popover, PopoverAnchor, PopoverContent } from '../overlays/Popover'

import {
  calendarDateValueToDate,
  dateToCalendarDateValue,
  dateToCalendarMonthValue,
  formatCalendarDateDisplay,
  getTodayCalendarDateValue,
} from './calendarDate'

export interface CalendarProps {
  ariaLabel?: string
  className?: string
  disabled?: boolean
  localeCode?: 'en-US' | 'zh-CN'
  monthValue?: LooseOptional<string>
  onChange: (value: string) => void
  onMonthChange?: (value: string) => void
  value?: LooseOptional<string>
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6
}

const calendarClassNames: DayPickerProps['classNames'] = {
  button_next: 'velar-calendar-nav-button velar-calendar-nav-button-next',
  button_previous: 'velar-calendar-nav-button velar-calendar-nav-button-previous',
  caption_label: 'velar-calendar-month-label',
  chevron: 'velar-calendar-chevron',
  day: 'velar-calendar-day-cell',
  day_button: 'velar-calendar-day-button',
  disabled: 'velar-calendar-day-disabled',
  hidden: 'velar-calendar-day-hidden',
  month: 'velar-calendar-month',
  month_caption: 'velar-calendar-header',
  month_grid: 'velar-calendar-grid',
  months: 'velar-calendar-months',
  nav: 'velar-calendar-nav',
  outside: 'velar-calendar-day-adjacent',
  range_end: 'velar-calendar-range-end',
  range_middle: 'velar-calendar-range-middle',
  range_start: 'velar-calendar-range-start',
  selected: 'velar-calendar-day-selected',
  today: 'velar-calendar-day-today',
  week: 'velar-calendar-week',
  weekday: 'velar-calendar-weekday',
  weekdays: 'velar-calendar-weekdays',
}

function nullableDateToOptional(value: Nullable<Date>): Date | undefined {
  return optionalWhen(isPresent(value), value as Date)
}

export const Calendar = memo(function Calendar({
  ariaLabel,
  className,
  disabled = false,
  localeCode,
  monthValue,
  onChange,
  onMonthChange,
  value,
  weekStartsOn = 0,
}: CalendarProps): ReactElement {
  const localization = useUiLocalization()
  const resolvedLocaleCode = localeCode ?? localization.localeCode
  const selectedDate = calendarDateValueToDate(value)
  const controlledMonth = calendarDateValueToDate(monthValue)
  const defaultMonth = selectedDate ?? controlledMonth ?? new Date()

  return (
    <div
      className={cn('velar-calendar', className)}
      role="group"
      aria-label={ariaLabel ?? localization.calendar}
    >
      <DayPicker
        mode="single"
        weekStartsOn={weekStartsOn}
        locale={resolvedLocaleCode === 'en-US' ? enUS : zhCN}
        selected={nullableDateToOptional(selectedDate)}
        defaultMonth={defaultMonth}
        month={nullableDateToOptional(controlledMonth)}
        disabled={disabled}
        disableNavigation={disabled}
        className="velar-calendar-day-picker"
        classNames={calendarClassNames}
        onMonthChange={(nextMonth) => onMonthChange?.(dateToCalendarMonthValue(nextMonth))}
        onSelect={(nextDate) => {
          if (nextDate) onChange(dateToCalendarDateValue(nextDate))
        }}
      />
    </div>
  )
})

Calendar.displayName = 'Calendar'

export interface CalendarDateRangeValue {
  end?: string
  start: string
}

export interface CalendarRangeProps {
  ariaLabel?: string
  className?: string
  disabled?: boolean
  localeCode?: 'en-US' | 'zh-CN'
  maxValue?: string
  minValue?: string
  monthValue?: LooseOptional<string>
  onChange: (value: CalendarDateRangeValue) => void
  value?: LooseOptional<CalendarDateRangeValue>
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6
}

function toCalendarDateRange(value: LooseOptional<CalendarDateRangeValue>): DateRange | undefined {
  const from = calendarDateValueToDate(value?.start)
  if (!from) return undefined

  return {
    from,
    to: nullableDateToOptional(calendarDateValueToDate(value?.end)),
  }
}

export const CalendarRange = memo(function CalendarRange({
  ariaLabel,
  className,
  disabled = false,
  localeCode,
  maxValue,
  minValue,
  monthValue,
  onChange,
  value,
  weekStartsOn = 0,
}: CalendarRangeProps): ReactElement {
  const localization = useUiLocalization()
  const resolvedLocaleCode = localeCode ?? localization.localeCode
  const selectedRange = toCalendarDateRange(value)
  const controlledMonth = calendarDateValueToDate(monthValue)
  const maxDate = calendarDateValueToDate(maxValue)
  const minDate = calendarDateValueToDate(minValue)
  const defaultMonth = selectedRange?.from ?? controlledMonth ?? new Date()
  const disabledDates = [
    ...(minDate ? [{ before: minDate }] : []),
    ...(maxDate ? [{ after: maxDate }] : []),
  ]

  return (
    <div
      className={cn('velar-calendar', className)}
      role="group"
      aria-label={ariaLabel ?? localization.calendarRange}
    >
      <DayPicker
        mode="range"
        resetOnSelect
        weekStartsOn={weekStartsOn}
        locale={resolvedLocaleCode === 'en-US' ? enUS : zhCN}
        selected={selectedRange}
        defaultMonth={defaultMonth}
        month={nullableDateToOptional(controlledMonth)}
        disabled={disabled ? true : disabledDates.length > 0 ? disabledDates : undefined}
        disableNavigation={disabled}
        startMonth={nullableDateToOptional(minDate)}
        endMonth={nullableDateToOptional(maxDate)}
        className="velar-calendar-day-picker"
        classNames={calendarClassNames}
        onSelect={(nextRange) => {
          if (!nextRange?.from) return
          onChange({
            start: dateToCalendarDateValue(nextRange.from),
            end: nextRange.to ? dateToCalendarDateValue(nextRange.to) : undefined,
          })
        }}
      />
    </div>
  )
})

CalendarRange.displayName = 'CalendarRange'

export interface CalendarDatePickerProps {
  ariaLabel?: string
  calendarLabel?: string
  className?: string
  clearLabel?: string
  disabled?: boolean
  displayValue?: string
  id?: string
  localeCode?: 'en-US' | 'zh-CN'
  onChange: (value: Nullable<string>) => void
  placeholder?: string
  todayLabel?: string
  value?: LooseOptional<string>
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6
}

export const CalendarDatePicker = memo(function CalendarDatePicker({
  ariaLabel,
  calendarLabel,
  className,
  clearLabel,
  disabled = false,
  displayValue,
  id,
  localeCode,
  onChange,
  placeholder,
  todayLabel,
  value,
  weekStartsOn = 0,
}: CalendarDatePickerProps): ReactElement {
  const localization = useUiLocalization()
  const [open, setOpen] = useState(false)
  const todayValue = getTodayCalendarDateValue()
  const resolvedDisplayValue = displayValue?.trim() || formatCalendarDateDisplay(value)

  const handleChange = (nextValue: string): void => {
    onChange(nextValue)
    setOpen(false)
  }

  const handleToday = (): void => {
    handleChange(todayValue)
  }

  const handleClear = (): void => {
    onChange(null)
    setOpen(false)
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
          id={id}
          type="button"
          className={cn(
            'velar-calendar-date-picker-trigger',
            !resolvedDisplayValue && 'velar-calendar-date-picker-trigger-placeholder',
            className
          )}
          disabled={disabled}
          aria-label={ariaLabel ?? localization.chooseDate}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <CalendarBlankIcon className="velar-calendar-date-picker-icon" />
          <span className="velar-calendar-date-picker-label">
            {resolvedDisplayValue || placeholder || localization.datePlaceholder}
          </span>
        </button>
      </PopoverAnchor>
      <PopoverContent align="start" sideOffset={8} className="velar-calendar-date-picker-popover">
        <Calendar
          value={value}
          ariaLabel={calendarLabel ?? localization.calendar}
          localeCode={localeCode ?? localization.localeCode}
          monthValue={value ?? todayValue}
          weekStartsOn={weekStartsOn}
          onChange={handleChange}
        />
        <div className="velar-calendar-date-picker-actions">
          <Button
            variant="ghost"
            size="sm"
            className="velar-calendar-date-picker-action"
            onClick={handleClear}
          >
            <XIcon size={14} />
            {clearLabel ?? localization.clear}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="velar-calendar-date-picker-action"
            onClick={handleToday}
          >
            {todayLabel ?? localization.today}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
})

CalendarDatePicker.displayName = 'CalendarDatePicker'

export interface CalendarDateRangePickerProps {
  ariaLabel?: string
  calendarLabel?: string
  className?: string
  clearLabel?: string
  disabled?: boolean
  displayValue?: string
  id?: string
  localeCode?: 'en-US' | 'zh-CN'
  maxValue?: string
  minValue?: string
  onChange: (value: Nullable<Required<CalendarDateRangeValue>>) => void
  placeholder?: string
  showClearAction?: boolean
  todayLabel?: string
  value?: LooseOptional<Required<CalendarDateRangeValue>>
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6
}

export const CalendarDateRangePicker = memo(function CalendarDateRangePicker({
  ariaLabel,
  calendarLabel,
  className,
  clearLabel,
  disabled = false,
  displayValue,
  id,
  localeCode,
  maxValue,
  minValue,
  onChange,
  placeholder,
  showClearAction = true,
  todayLabel,
  value,
  weekStartsOn = 0,
}: CalendarDateRangePickerProps): ReactElement {
  const localization = useUiLocalization()
  const [open, setOpen] = useState(false)
  const [draftValue, setDraftValue] = useState<LooseOptional<CalendarDateRangeValue>>(value)
  const todayValue = getTodayCalendarDateValue()
  const resolvedDisplayValue = displayValue?.trim()
  const valueStart = value?.start
  const valueEnd = value?.end

  useEffect(() => {
    if (open) return
    setDraftValue(valueStart && valueEnd ? { start: valueStart, end: valueEnd } : undefined)
  }, [open, valueEnd, valueStart])

  const handleOpenChange = (nextOpen: boolean): void => {
    if (disabled) return
    if (nextOpen) setDraftValue(value)
    setOpen(nextOpen)
  }

  const handleRangeChange = (nextValue: CalendarDateRangeValue): void => {
    setDraftValue(nextValue)
    if (!nextValue.end) return
    onChange({ start: nextValue.start, end: nextValue.end })
    setOpen(false)
  }

  const handleToday = (): void => {
    onChange({ start: todayValue, end: todayValue })
    setOpen(false)
  }

  const handleClear = (): void => {
    onChange(null)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <button
          id={id}
          type="button"
          className={cn(
            'velar-calendar-date-picker-trigger',
            'velar-calendar-date-range-picker-trigger',
            !resolvedDisplayValue && 'velar-calendar-date-picker-trigger-placeholder',
            className
          )}
          disabled={disabled}
          aria-label={ariaLabel ?? localization.chooseDateRange}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => handleOpenChange(!open)}
        >
          <span className="velar-calendar-date-picker-label">
            {resolvedDisplayValue || placeholder || localization.dateRangePlaceholder}
          </span>
          <span className="velar-calendar-date-range-picker-icons" aria-hidden="true">
            <CalendarBlankIcon className="velar-calendar-date-picker-icon" />
            <CaretDownIcon className="velar-calendar-date-range-picker-chevron" />
          </span>
        </button>
      </PopoverAnchor>
      <PopoverContent align="end" sideOffset={8} className="velar-calendar-date-picker-popover">
        <CalendarRange
          value={draftValue}
          ariaLabel={calendarLabel ?? localization.calendarRange}
          localeCode={localeCode ?? localization.localeCode}
          maxValue={maxValue}
          minValue={minValue}
          monthValue={draftValue?.start ?? value?.start ?? todayValue}
          weekStartsOn={weekStartsOn}
          onChange={handleRangeChange}
        />
        <div
          className={cn(
            'velar-calendar-date-picker-actions',
            !showClearAction && 'velar-calendar-date-picker-actions-single'
          )}
        >
          {showClearAction && (
            <Button
              variant="ghost"
              size="sm"
              className="velar-calendar-date-picker-action"
              onClick={handleClear}
            >
              <XIcon size={14} />
              {clearLabel ?? localization.clear}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="velar-calendar-date-picker-action"
            onClick={handleToday}
          >
            {todayLabel ?? localization.today}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
})

CalendarDateRangePicker.displayName = 'CalendarDateRangePicker'
