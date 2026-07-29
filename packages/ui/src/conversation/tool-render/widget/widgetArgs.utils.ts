import { MAX_WIDGET_HEIGHT, MIN_WIDGET_HEIGHT } from './widgetToolConstants'

import type { AppLocale } from '#contracts'
import { isNumber,toNullable } from '#internal/runtime'
import {
  readNumberScalar as readNumber,
  readRecord,
  readStringScalar as readString,
} from '#internal/unknownJsonRecord'

export { readNumber, readRecord, readString }

export function clampHeight(value: number): number {
  return Math.min(Math.max(Math.ceil(value), MIN_WIDGET_HEIGHT), MAX_WIDGET_HEIGHT)
}

export function formatWidgetIdentifier(value: any): Nullable<string> {
  return toNullable(readString(value)?.replaceAll('_', ' ').trim())
}

export function readLocalizedWidgetTitle(args: Record<string, any>, locale: AppLocale): Nullable<string> {
  const titleMap =
    readRecord(args.display_title) ?? readRecord(args.localized_title) ?? readRecord(args.title_i18n)

  if (!titleMap) return null

  const localeKeys = locale === 'zh-CN' ? ['zh-CN', 'zh', 'zhCN'] : ['en-US', 'en', 'enUS']
  for (const key of localeKeys) {
    const title = readString(titleMap[key])
    if (title) return title
  }

  return null
}

export function resolveWidgetTitle(args: Record<string, any>, locale: AppLocale, fallback: string): string {
  const localizedTitle = readLocalizedWidgetTitle(args, locale)
  if (localizedTitle) return localizedTitle

  const identifierTitle = formatWidgetIdentifier(args.title)
  if (!identifierTitle) return fallback

  const isAsciiTitle = [...identifierTitle].every((char) => {
    const codePoint = char.codePointAt(0)
    return isNumber(codePoint) && codePoint <= 0x7f
  })

  if (locale === 'zh-CN' && isAsciiTitle) return fallback

  return identifierTitle
}
