import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

import type { MessageActionView } from '../projection'

import type { ChatMessage, WorkspaceRootEntry } from '#contracts'

/**
 * blocks 层的 **hook 注入端口**——把宿主专属、按消息派生的 viewmodel（触达 rendererIpc）以 hook 形式
 * 注入进包内渲染件。
 *
 * message-action viewmodel（open/reveal 路径经 rendererIpc + 工作区路径格式化）住宿主 hook
 * `useChatMessageActionViewModel`；包内 `AssistantMessageBubble` / `MessageActionList` 经此端口调用注入的
 * 稳定 hook（IPC 面全留宿主，包侧只吃 `MessageActionView` 投影 + 回调）。desktop 在装配点注入实现。
 *
 * `useAutoTranslateThinkingEnabled`（pass-3b2）：思考块自动翻译开关来自宿主 AppConfigProvider
 * （`useSystemConfig().modelProvider.thinking.autoTranslateThinking`）——包内 `ThinkingBlock` 经此 hook 读取，
 * 不直依宿主配置上下文。
 */
export interface ConversationMessageActionOptions {
  activeWorkspaceRoot: Nullable<string>
  message: ChatMessage
  onOpenWorkspacePath?: (path: string) => unknown
  sessionId: string
  workspaceRoots: WorkspaceRootEntry[]
}

export interface ConversationBlockHooks {
  useMessageActionView: (options: ConversationMessageActionOptions) => MessageActionView
  useAutoTranslateThinkingEnabled: () => boolean
}

const ConversationBlockHooksContext = createContext<Nullable<ConversationBlockHooks>>(null)

export function ConversationBlockHooksProvider({
  value,
  children,
}: {
  value: ConversationBlockHooks
  children: ReactNode
}): ReactElement {
  return (
    <ConversationBlockHooksContext.Provider value={value}>
      {children}
    </ConversationBlockHooksContext.Provider>
  )
}

export function useConversationBlockHooks(): ConversationBlockHooks {
  const value = useContext(ConversationBlockHooksContext)
  if (!value) {
    throw new Error(
      'useConversationBlockHooks must be used within ConversationBlockHooksProvider (host 装配点注入)。'
    )
  }
  return value
}
