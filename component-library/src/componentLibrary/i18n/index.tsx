import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'

import {
  configureConversationTranslator,
  ConversationLocalizationProvider,
} from '@velaros-ai/ui/conversation/i18n'
import {
  type UiLocalizationMessages,
  UiLocalizationProvider,
} from '@velaros-ai/ui/i18n/UiLocalizationProvider'

import type { CatalogLocale } from '../catalogPrimitives'

import { type MessageKey, messages } from './messages'

export interface TranslateParams {
  [key: string]: string | number
}

export interface I18nContextValue {
  locale: CatalogLocale
  setLocale: (locale: CatalogLocale) => Promise<void>
  t: (key: MessageKey, params?: TranslateParams) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

function readMessage(locale: CatalogLocale, key: string): string | null {
  const value = key.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return null
    return (current as Record<string, unknown>)[segment]
  }, messages[locale])

  return typeof value === 'string' ? value : null
}

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_match, token: string) => String(params[token] ?? ''))
}

function translate(locale: CatalogLocale, key: string, params?: TranslateParams): string {
  return interpolate(readMessage(locale, key) ?? key, params)
}

configureConversationTranslator({
  lookupMessage: (locale, key) => readMessage(locale, key),
  translate,
})

function createUiMessages(locale: CatalogLocale, t: I18nContextValue['t']): UiLocalizationMessages {
  return {
    breadcrumb: t('common.breadcrumb'),
    calendar: t('common.calendar'),
    calendarRange: t('common.calendarRange'),
    chooseDate: t('common.chooseDate'),
    chooseDateRange: t('common.chooseDateRange'),
    chooseTime: t('common.chooseTime'),
    clear: t('common.clear'),
    closeDialog: t('common.closeDialog'),
    datePlaceholder: t('common.datePlaceholder'),
    dateRangePlaceholder: t('common.dateRangePlaceholder'),
    dismiss: t('common.dismiss'),
    hour: t('common.hour'),
    hourOption: (value) => t('common.hourOption', { value }),
    loading: t('common.loading'),
    localeCode: locale,
    minute: t('common.minute'),
    minuteOption: (value) => t('common.minuteOption', { value }),
    progressPercent: (percent) => t('common.progressPercent', { percent }),
    remove: t('common.remove'),
    selectAllOnPage: t('common.selectAllOnPage'),
    selectRow: t('common.selectRow'),
    today: t('common.today'),
  }
}

export function CatalogI18nProvider({
  children,
  initialLocale = 'zh-CN',
}: {
  children: ReactNode
  initialLocale?: CatalogLocale
}): ReactElement {
  const [locale, setLocaleState] = useState<CatalogLocale>(initialLocale)
  const setLocale = useCallback(async (nextLocale: CatalogLocale): Promise<void> => {
    setLocaleState(nextLocale)
  }, [])
  const t = useCallback<I18nContextValue['t']>(
    (key, params) => translate(locale, key, params),
    [locale]
  )
  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  const uiMessages = useMemo(() => createUiMessages(locale, t), [locale, t])
  const conversationValue = useMemo(
    () => ({
      locale,
      setLocale,
      t: (key: string, params?: TranslateParams) => translate(locale, key, params),
    }),
    [locale, setLocale]
  )

  return (
    <I18nContext.Provider value={value}>
      <ConversationLocalizationProvider value={conversationValue}>
        <UiLocalizationProvider messages={uiMessages}>{children}</UiLocalizationProvider>
      </ConversationLocalizationProvider>
    </I18nContext.Provider>
  )
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used within CatalogI18nProvider')
  return value
}

export type { MessageKey } from './messages'
