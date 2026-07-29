import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

export interface UiLocalizationMessages {
  breadcrumb: string
  calendar: string
  calendarRange: string
  chooseDate: string
  chooseDateRange: string
  chooseTime: string
  clear: string
  closeDialog: string
  datePlaceholder: string
  dateRangePlaceholder: string
  dismiss: string
  hour: string
  hourOption: (value: string) => string
  loading: string
  localeCode: 'en-US' | 'zh-CN'
  minute: string
  minuteOption: (value: string) => string
  progressPercent: (percent: number) => string
  remove: string
  selectAllOnPage: string
  selectRow: string
  today: string
}

const DefaultUiLocalizationMessages: UiLocalizationMessages = {
  breadcrumb: 'Breadcrumb',
  calendar: 'Calendar',
  calendarRange: 'Calendar range',
  chooseDate: 'Choose date',
  chooseDateRange: 'Choose date range',
  chooseTime: 'Choose time',
  clear: 'Clear',
  closeDialog: 'Close dialog',
  datePlaceholder: 'Choose date',
  dateRangePlaceholder: 'Choose date range',
  dismiss: 'Dismiss',
  hour: 'Hour',
  hourOption: (value) => `${value} hour`,
  loading: 'Loading',
  localeCode: 'en-US',
  minute: 'Minute',
  minuteOption: (value) => `${value} minute`,
  progressPercent: (percent) => `${percent} percent`,
  remove: 'Remove',
  selectAllOnPage: 'Select all on page',
  selectRow: 'Select row',
  today: 'Today',
}

const UiLocalizationContext = createContext<UiLocalizationMessages>(DefaultUiLocalizationMessages)

interface UiLocalizationProviderProps {
  children: ReactNode
  messages: UiLocalizationMessages
}

export function UiLocalizationProvider({
  children,
  messages,
}: UiLocalizationProviderProps): ReactElement {
  return (
    <UiLocalizationContext.Provider value={messages}>{children}</UiLocalizationContext.Provider>
  )
}

export function useUiLocalization(): UiLocalizationMessages {
  return useContext(UiLocalizationContext)
}
