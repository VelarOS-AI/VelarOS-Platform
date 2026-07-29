/**
 * Chat stream scope key。
 *
 * 每个 source session 拥有一个稳定 stream scope key。
 */
export interface ChatStreamScope {
  sourceSessionId: string
}

export function createChatStreamScopeKey(sourceSessionId: string): string {
  return sourceSessionId
}

export function readChatStreamScopeKey(scope: ChatStreamScope): string {
  return createChatStreamScopeKey(scope.sourceSessionId)
}

export function readChatStreamSourceSessionId(scopeKey: string): string {
  return scopeKey
}
