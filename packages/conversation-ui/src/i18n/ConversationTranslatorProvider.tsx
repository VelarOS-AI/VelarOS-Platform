import { createContext, type ReactNode, useContext } from 'react'

import {
  type ConversationTranslatorRuntime,
  conversationTranslatorRuntime,
} from './conversationTranslator'

const ConversationTranslatorRuntimeContext =
  createContext<Nullable<ConversationTranslatorRuntime>>(null)

export function ConversationTranslatorProvider({
  children,
  runtime,
}: {
  children: ReactNode
  runtime: ConversationTranslatorRuntime
}): React.JSX.Element {
  return (
    <ConversationTranslatorRuntimeContext.Provider value={runtime}>
      {children}
    </ConversationTranslatorRuntimeContext.Provider>
  )
}

/**
 * 返回当前 React root 的翻译运行时。
 *
 * 未安装 Provider 时回退默认实例仅为兼容；新应用应显式安装 Provider。
 */
export function useConversationTranslatorRuntime(): ConversationTranslatorRuntime {
  return useContext(ConversationTranslatorRuntimeContext) ?? conversationTranslatorRuntime
}
