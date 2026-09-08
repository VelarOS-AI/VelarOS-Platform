export type ConversationRefreshKey = string | number | undefined

export interface ConversationRefreshGeneration {
  readonly sessionId: string
  readonly key: ConversationRefreshKey
}

interface ResolveConversationRefreshGenerationInput {
  readonly sessionId: string
  readonly key: ConversationRefreshKey
  readonly isRunActive: boolean
}

/**
 * 流式执行期间冻结消息树 remount generation。宿主若误把 token revision 当刷新键，内容仍可
 * 正常增量渲染，但不会每帧卸载滚动容器；终态或切换会话后再一次性接受最新结构键。
 */
export function resolveConversationRefreshGeneration(
  current: Nullable<ConversationRefreshGeneration>,
  input: ResolveConversationRefreshGenerationInput
): ConversationRefreshGeneration {
  if (
    current
    && current.sessionId === input.sessionId
    && input.isRunActive
  ) return current

  if (
    current
    && current.sessionId === input.sessionId
    && Object.is(current.key, input.key)
  ) return current

  return { sessionId: input.sessionId, key: input.key }
}
