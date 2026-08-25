import type { ChatMessage } from '#contracts'
import { isConversationTurnInputMessage, isRunGuidanceMessage } from '#contracts'
import { isEmpty } from '#internal/runtime'

export interface ChatTranscriptMessagePresentation {
  message: ChatMessage
  activityLeadingMessages: ChatMessage[]
  activityTrailingMessages: ChatMessage[]
}

function appendTurnPresentations(
  messages: readonly ChatMessage[],
  startIndex: number,
  endIndex: number,
  presentations: ChatTranscriptMessagePresentation[]
): void {
  const turnMessages = messages.slice(startIndex, endIndex)
  const hasGuidance = turnMessages.some(isRunGuidanceMessage)

  if (!hasGuidance) {
    turnMessages.forEach((message) => {
      presentations.push({
        message,
        activityLeadingMessages: [],
        activityTrailingMessages: [],
      })
    })
    return
  }

  const firstGuidanceIndex = turnMessages.findIndex(isRunGuidanceMessage)
  let anchorIndex = -1
  for (let index = firstGuidanceIndex - 1; index >= 0; index -= 1) {
    if (turnMessages[index]?.role === 'assistant') {
      anchorIndex = index
      break
    }
  }

  // 锚定引导前已经挂载的 assistant，插入引导时不换宿主、不重置其内部折叠状态。
  // 引导刚写入、但本轮尚未产出任何 assistant 消息时没有可承载活动的气泡，保持原顺序。
  if (anchorIndex < 0) {
    turnMessages.forEach((message) => {
      presentations.push({
        message,
        activityLeadingMessages: [],
        activityTrailingMessages: [],
      })
    })
    return
  }

  const groupedMessageIndexes = new Set<number>()
  const activityLeadingMessages: ChatMessage[] = []
  const activityTrailingMessages: ChatMessage[] = []

  turnMessages.forEach((message, index) => {
    if (index === anchorIndex) return
    if (isConversationTurnInputMessage(message)) return

    // 一次真正的 turn-input 之间只存在同一轮执行的内部状态：assistant 片段、run-guidance、
    // interaction-reply 与 system-notice 都维持原顺序进入活动容器；数据本身不合并、不改 role。
    groupedMessageIndexes.add(index)
    if (index < anchorIndex) activityLeadingMessages.push(message)
    else activityTrailingMessages.push(message)
  })

  turnMessages.forEach((message, index) => {
    if (groupedMessageIndexes.has(index)) return

    presentations.push({
      message,
      activityLeadingMessages: index === anchorIndex ? activityLeadingMessages : [],
      activityTrailingMessages: index === anchorIndex ? activityTrailingMessages : [],
    })
  })
}

/**
 * 把同一 turn 内被 run-guidance 切开的 assistant 片段投影成一个呈现单元。
 *
 * 数据层仍保留原始 user/assistant 消息顺序，供模型历史、持久化与回放使用；这里只改变 transcript
 * 的渲染归属，使运行中保持平铺，完成后由最后一条 assistant 消息统一收进「已处理」。
 */
export function buildChatTranscriptMessagePresentations(
  messages: readonly ChatMessage[]
): ChatTranscriptMessagePresentation[] {
  if (isEmpty(messages)) return []

  const presentations: ChatTranscriptMessagePresentation[] = []
  let sectionStartIndex = 0

  for (let index = 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || !isConversationTurnInputMessage(message)) continue

    appendTurnPresentations(messages, sectionStartIndex, index, presentations)
    sectionStartIndex = index
  }

  appendTurnPresentations(messages, sectionStartIndex, messages.length, presentations)
  return presentations
}
