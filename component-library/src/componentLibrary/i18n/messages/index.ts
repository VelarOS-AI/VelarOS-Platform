import type { CatalogLocale } from '../../catalogPrimitives'

import { enUSMessages } from './en-US'
import { zhCNMessages } from './zh-CN'

export const messages = {
  'zh-CN': zhCNMessages,
  'en-US': enUSMessages,
} as const satisfies Record<CatalogLocale, Record<string, any>>

type JoinPath<Prefix extends string, Key extends string> = Prefix extends ''
  ? Key
  : `${Prefix}.${Key}`

type LeafMessageKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? JoinPath<Prefix, K>
    : T[K] extends Record<string, any>
      ? LeafMessageKeys<T[K], JoinPath<Prefix, K>>
      : never
}[keyof T & string]

type LocaleMessages = typeof zhCNMessages

export type MessageKey = LeafMessageKeys<LocaleMessages>
