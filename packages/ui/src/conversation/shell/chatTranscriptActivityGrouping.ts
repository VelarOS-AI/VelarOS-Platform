import type { ChatMessage } from '#contracts'
import { isConversationTurnInputMessage, isRunGuidanceMessage } from '#contracts'
import { isEmpty } from '#internal/runtime'

export interface ChatTranscriptMessagePresentation {
  message: ChatMessage
  activityLeadingMessages: ChatMessage[]
  activityTrailingMessages: ChatMessage[]
  /** 后续独立 turn 已经开始、但宿主漏存完成 marker 时，用 turn 边界补齐上一轮的已处理语义。 */
  implicitlyCompletedRun: boolean
}

export interface ChatTranscriptMessagePresentationOptions {
  /** 正常完成的最终 assistant 承担整轮唯一的「已处理」边界。 */
  isCompletedAssistant?: (message: ChatMessage) => boolean
  /** 任意显式运行 marker 都优先于 turn 边界推断，避免把失败或等待态误判为完成。 */
  hasRunMarker?: (message: ChatMessage) => boolean
}

function appendTurnPresentations(
  messages: readonly ChatMessage[],
  startIndex: number,
  endIndex: number,
  presentations: ChatTranscriptMessagePresentation[],
  options: ChatTranscriptMessagePresentationOptions
): void {
  const turnMessages = messages.slice(startIndex, endIndex)
  const hasGuidance = turnMessages.some(isRunGuidanceMessage)
  const turnIsClosed = endIndex < messages.length
  const completedAnchorIndex = turnMessages.findLastIndex(
    (message) => message.role === 'assistant' && !!options.isCompletedAssistant?.(message)
  )
  const terminalAnchorIndex = turnMessages.findLastIndex(
    (message) => message.role === 'assistant' && !!options.hasRunMarker?.(message)
  )
  const lastAssistantIndex = turnMessages.findLastIndex(
    (message) => message.role === 'assistant'
  )
  const implicitCompletedAnchorIndex =
    turnIsClosed && completedAnchorIndex < 0 && terminalAnchorIndex < 0
      ? lastAssistantIndex
      : -1

  const pushPresentation = (
    message: ChatMessage,
    index: number,
    activityLeadingMessages: ChatMessage[] = [],
    activityTrailingMessages: ChatMessage[] = []
  ): void => {
    presentations.push({
      message,
      activityLeadingMessages,
      activityTrailingMessages,
      implicitlyCompletedRun: index === implicitCompletedAnchorIndex,
    })
  }

  if (!hasGuidance) {
    turnMessages.forEach((message, index) => pushPresentation(message, index))
    return
  }

  const firstGuidanceIndex = turnMessages.findIndex(isRunGuidanceMessage)
  let activeAnchorIndex = -1
  for (let index = firstGuidanceIndex - 1; index >= 0; index -= 1) {
    if (turnMessages[index]?.role === 'assistant') {
      activeAnchorIndex = index
      break
    }
  }

  const anchorIndex =
    completedAnchorIndex >= 0
      ? completedAnchorIndex
      : implicitCompletedAnchorIndex >= 0
        ? implicitCompletedAnchorIndex
        : terminalAnchorIndex >= 0
          ? terminalAnchorIndex
          : activeAnchorIndex

  // 运行中锚定引导前已经挂载的 assistant，插入引导时不换宿主、不重置内部状态；只有正常
  // 完成后才切到最终 assistant，让它把总结留在外面，并承载整轮唯一的「已处理」。
  // 引导刚写入、但本轮尚未产出任何 assistant 消息时没有可承载活动的气泡，保持原顺序。
  if (anchorIndex < 0) {
    turnMessages.forEach((message, index) => pushPresentation(message, index))
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

    pushPresentation(
      message,
      index,
      index === anchorIndex ? activityLeadingMessages : [],
      index === anchorIndex ? activityTrailingMessages : []
    )
  })
}

/**
 * 把同一 turn 内被 run-guidance 切开的 assistant 片段投影成一个呈现单元。
 *
 * 数据层仍保留原始 user/assistant 消息顺序，供模型历史、持久化与回放使用；这里只改变 transcript
 * 的渲染归属，使运行中保持平铺，完成后由最后一条 assistant 消息统一收进「已处理」。
 */
export function buildChatTranscriptMessagePresentations(
  messages: readonly ChatMessage[],
  options: ChatTranscriptMessagePresentationOptions = {}
): ChatTranscriptMessagePresentation[] {
  if (isEmpty(messages)) return []

  const presentations: ChatTranscriptMessagePresentation[] = []
  let sectionStartIndex = 0

  for (let index = 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || !isConversationTurnInputMessage(message)) continue

    appendTurnPresentations(messages, sectionStartIndex, index, presentations, options)
    sectionStartIndex = index
  }

  appendTurnPresentations(messages, sectionStartIndex, messages.length, presentations, options)
  return presentations
}
