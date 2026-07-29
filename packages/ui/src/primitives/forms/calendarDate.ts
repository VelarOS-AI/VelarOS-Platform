import { isFiniteNumber } from '../../lib/runtime'
export interface CalendarDateParts {
  day: number
  month: number
  year: number
}

const DateValuePattern = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u
const TimeValuePattern = /^(?<hour>\d{2}):(?<minute>\d{2})$/u

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function isValidDateParts(parts: CalendarDateParts): boolean {
  const date = new Date(parts.year, parts.month - 1, parts.day)

  return (
    date.getFullYear() === parts.year &&
    date.getMonth() === parts.month - 1 &&
    date.getDate() === parts.day
  )
}

export function formatCalendarDateValue(parts: CalendarDateParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

export function parseCalendarDateValue(value: LooseOptional<string>): Nullable<CalendarDateParts> {
  const match = value?.match(DateValuePattern)
  if (!match?.groups) return null

  const parts = {
    day: +match.groups.day,
    month: +match.groups.month,
    year: +match.groups.year,
  }

  return isValidDateParts(parts) ? parts : null
}

export function dateToCalendarDateValue(value: Date): string {
  return formatCalendarDateValue({
    day: value.getDate(),
    month: value.getMonth() + 1,
    year: value.getFullYear(),
  })
}

export function dateToCalendarMonthValue(value: Date): string {
  return formatCalendarDateValue({
    day: 1,
    month: value.getMonth() + 1,
    year: value.getFullYear(),
  })
}

export function calendarDateValueToDate(value: LooseOptional<string>): Nullable<Date> {
  const parts = parseCalendarDateValue(value)

  return parts ? new Date(parts.year, parts.month - 1, parts.day) : null
}

export function getTodayCalendarDateValue(now = new Date()): string {
  return formatCalendarDateValue({
    day: now.getDate(),
    month: now.getMonth() + 1,
    year: now.getFullYear(),
  })
}

export function getCalendarMonthValue(value: LooseOptional<string>): string {
  const date = calendarDateValueToDate(value) ?? new Date()

  return dateToCalendarMonthValue(date)
}

export function formatCalendarDateDisplay(value: LooseOptional<string>): string {
  const parts = parseCalendarDateValue(value)
  if (!parts) return ''

  return `${parts.year}年${pad2(parts.month)}月${pad2(parts.day)}日`
}

export function formatCalendarDateTimeDisplay(
  dateValue: LooseOptional<string>,
  timeValue: LooseOptional<string>
): string {
  const dateDisplay = formatCalendarDateDisplay(dateValue)
  if (!dateDisplay.trim()) return ''

  return timeValue?.trim() ? `${dateDisplay} ${timeValue}` : dateDisplay
}

export function timestampToCalendarDateValue(timestamp: LooseOptional<number>): string {
  if (!isFiniteNumber(timestamp)) return ''

  return dateToCalendarDateValue(new Date(timestamp))
}

export function timestampToCalendarTimeValue(timestamp: LooseOptional<number>): string {
  if (!isFiniteNumber(timestamp)) return ''

  const date = new Date(timestamp)

  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function calendarDateTimeToTimestamp(
  dateValue: LooseOptional<string>,
  timeValue = '00:00'
): Nullable<number> {
  const dateParts = parseCalendarDateValue(dateValue)
  const timeMatch = timeValue.match(TimeValuePattern)

  if (!dateParts || !timeMatch?.groups) return null

  const hour = +timeMatch.groups.hour
  const minute = +timeMatch.groups.minute
  if (hour > 23 || minute > 59) return null

  return new Date(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute).getTime()
}
