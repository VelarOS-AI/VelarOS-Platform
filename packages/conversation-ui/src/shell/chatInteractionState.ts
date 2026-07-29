import type { ChatRunStatus } from '../status/chatStatus'

/**
 * 会话交互状态 —— isStreaming 与 runtime.status 的唯一合并读法（会话壳消费子集）。
 *
 * 宿主 `chatRuntimeLifecycle` 还带一批基于 `ChatSession` 的 store 逻辑（非会话壳私有、chat store 也用），
 * 那部分留宿主；此处只**复制**会话壳渲染需要的窄 util（吃原语 isStreaming + ChatRunStatus，零宿主耦合）。
 */
export type ChatSessionInteractionState =
  | 'idle'
  | 'streaming'
  | 'running'
  | 'awaiting-confirmation'
  | 'awaiting-input'

export function resolveChatInteractionState(
  isStreaming: boolean,
  status: ChatRunStatus
): ChatSessionInteractionState {
  if (status === 'awaiting-confirmation' || status === 'awaiting-input') return status
  if (isStreaming) return 'streaming'
  if (status === 'running') return 'running'
  return 'idle'
}

/** run 是否在推进（流式或运行中）；等待交互不算推进（阻塞态由用户解锁）。 */
export function isChatInteractionRunActive(state: ChatSessionInteractionState): boolean {
  return state === 'streaming' || state === 'running'
}
