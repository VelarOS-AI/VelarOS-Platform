import type {
  ConversationMessageKey,
  ConversationTranslateParams,
} from './ConversationLocalizationProvider'

import type { AppLocale } from '#contracts'

/** React 外纯模型消费的最小翻译端口。 */
export interface ConversationTranslator {
  translate: (
    locale: AppLocale,
    key: ConversationMessageKey,
    params?: ConversationTranslateParams
  ) => string
  lookupMessage: (locale: AppLocale, key: ConversationMessageKey) => Nullable<string>
}

/**
 * 一个可独立配置和销毁的会话翻译运行时。
 *
 * 多窗口、多 React root 和测试应各自创建实例；实例之间不共享 locale、目录或配置状态。
 */
export class ConversationTranslatorRuntime implements ConversationTranslator {
  private translator: Nullable<ConversationTranslator>

  public constructor(translator?: ConversationTranslator) {
    this.translator = translator ?? null
  }

  public get isConfigured(): boolean {
    return this.translator !== null
  }

  public configure(translator: ConversationTranslator): this {
    if (!translator?.translate || !translator.lookupMessage) {
      throw new TypeError('conversation-ui: translator must provide translate and lookupMessage')
    }
    this.translator = translator
    return this
  }

  public clear(expectedTranslator?: ConversationTranslator): boolean {
    if (!this.translator) return false
    if (expectedTranslator && this.translator !== expectedTranslator) return false
    this.translator = null
    return true
  }

  public readonly translate = (
    locale: AppLocale,
    key: ConversationMessageKey,
    params?: ConversationTranslateParams
  ): string => this.requireTranslator().translate(locale, key, params)

  public readonly lookupMessage = (
    locale: AppLocale,
    key: ConversationMessageKey
  ): Nullable<string> => this.requireTranslator().lookupMessage(locale, key)

  public dispose(): void {
    this.clear()
  }

  private requireTranslator(): ConversationTranslator {
    if (!this.translator) {
      throw new Error(
        'conversation-ui: 翻译器未注入——请在会话 UI 的组合根安装 ConversationTranslatorProvider。'
      )
    }
    return this.translator
  }
}

/** 旧 API 使用的进程级默认实例。新应用应为每个 composition root 创建独立实例。 */
export const conversationTranslatorRuntime = new ConversationTranslatorRuntime()

/** @deprecated 使用 `new ConversationTranslatorRuntime(translator)` 并通过 Provider 注入。 */
export function configureConversationTranslator(translator: ConversationTranslator): void {
  conversationTranslatorRuntime.configure(translator)
}

/** @deprecated React 内使用 `useConversationTranslatorRuntime()`；纯模型显式传 runtime。 */
export function conversationTranslate(
  locale: AppLocale,
  key: ConversationMessageKey,
  params?: ConversationTranslateParams,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): string {
  return runtime.translate(locale, key, params)
}

/** @deprecated React 内使用 `useConversationTranslatorRuntime()`；纯模型显式传 runtime。 */
export function conversationLookupMessage(
  locale: AppLocale,
  key: ConversationMessageKey,
  runtime: ConversationTranslator = conversationTranslatorRuntime
): Nullable<string> {
  return runtime.lookupMessage(locale, key)
}
