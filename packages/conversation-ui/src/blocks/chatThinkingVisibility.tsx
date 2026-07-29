import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

/**
 * 当前会话是否展示「思考过程」的纯展示偏好（无 IPC / 无状态半壁,零耦合搬入包）。宿主在装配点按
 * composer 偏好提供 `visible`;缺 Provider 的独立预览默认展示。
 */
const ChatThinkingVisibilityContext = createContext(true)

export function ChatThinkingVisibilityProvider({
  children,
  visible,
}: {
  children: ReactNode
  visible: boolean
}): ReactElement {
  return (
    <ChatThinkingVisibilityContext.Provider value={visible}>
      {children}
    </ChatThinkingVisibilityContext.Provider>
  )
}

export function useChatThinkingVisibility(): boolean {
  return useContext(ChatThinkingVisibilityContext)
}
