import React, { createContext, useContext, useMemo } from 'react'

import {
  type ChatToolRenderCapabilities,
  emptyChatToolRenderCapabilities,
} from './chatToolRenderCapabilities'

const ChatToolRenderCapabilitiesContext = createContext<ChatToolRenderCapabilities>(
  emptyChatToolRenderCapabilities
)

function ChatToolRenderCapabilitiesProvider({
  value,
  children,
}: {
  value: ChatToolRenderCapabilities
  children: React.ReactNode
}): React.ReactElement {
  const memoizedValue = useMemo(() => value, [value])

  return (
    <ChatToolRenderCapabilitiesContext.Provider value={memoizedValue}>
      {children}
    </ChatToolRenderCapabilitiesContext.Provider>
  )
}

function useChatToolRenderCapabilities(): ChatToolRenderCapabilities {
  return useContext(ChatToolRenderCapabilitiesContext)
}

export { ChatToolRenderCapabilitiesProvider, useChatToolRenderCapabilities }
