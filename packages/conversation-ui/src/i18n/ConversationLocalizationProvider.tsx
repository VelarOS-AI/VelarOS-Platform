import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
} from 'react'

import { ConversationTranslatorRuntime } from './conversationTranslator'
import { ConversationTranslatorProvider } from './ConversationTranslatorProvider'

import type { AppLocale } from '#contracts'

/**
 * 会话渲染门面的窄本地化契约（镜像 @velaros-ai/workbench 的 WorkbenchLocalizationProvider 先例）。
 *
 * conversation-ui 不直依 desktop 的 `@/i18n`（那里挂着上百条 message key 与偏好设置耦合）——
 * 包只声明「locale + t(key) + setLocale」三成员的注入面，key 类型收为 `string`（消费方在注入点
 * 用桥接 cast 对齐自己的 MessageKey 目录）。desktop 在 I18nProvider 处注入其现有 `useI18n()` 实现。
 */
export type ConversationMessageKey = string

export interface ConversationTranslateParams {
  [key: string]: string | number
}

export interface ConversationI18nContextValue {
  locale: AppLocale
  setLocale: (locale: AppLocale) => Promise<void>
  t: (key: ConversationMessageKey, params?: ConversationTranslateParams) => string
}

const ConversationLocalizationContext = createContext<Nullable<ConversationI18nContextValue>>(null)

export function ConversationLocalizationProvider({
  children,
  translatorRuntime,
  value,
}: {
  children: ReactNode
  /** 高级用法：复用宿主持有的实例；省略时 Provider 为当前 root 创建隔离实例。 */
  translatorRuntime?: ConversationTranslatorRuntime
  value: ConversationI18nContextValue
}): ReactElement {
  const ownedRuntime = useMemo(
    () =>
      new ConversationTranslatorRuntime({
        translate: (_locale, key, params) => value.t(key, params),
        lookupMessage: (_locale, key) => {
          const translated = value.t(key)
          return translated === key ? null : translated
        },
      }),
    [value]
  )
  const runtime = translatorRuntime ?? ownedRuntime

  return (
    <ConversationTranslatorProvider runtime={runtime}>
      <ConversationLocalizationContext.Provider value={value}>
        {children}
      </ConversationLocalizationContext.Provider>
    </ConversationTranslatorProvider>
  )
}

export function useConversationI18n(): ConversationI18nContextValue {
  const context = useContext(ConversationLocalizationContext)
  if (!context) {
    throw new Error('useConversationI18n must be used within ConversationLocalizationProvider')
  }
  return context
}
