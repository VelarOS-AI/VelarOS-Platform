/**
 * 对话区向上翻页哨兵判定（会话壳滚动 hook 消费子集）。宿主 `@utils/chat/chatConversationScroll.utils`
 * 还带其他多域消费者，随壳退场；此处只复制会话壳用到的纯谓词。
 */
export interface OlderMessageSentinelState {
  hasOlderMessages: boolean
  hasLoadHandler: boolean
  initialBottomScrollSettled: boolean
}

export function shouldObserveOlderMessageSentinel({
  hasOlderMessages,
  hasLoadHandler,
  initialBottomScrollSettled,
}: OlderMessageSentinelState): boolean {
  return hasOlderMessages && hasLoadHandler && initialBottomScrollSettled
}
