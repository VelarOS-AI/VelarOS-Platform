/**
 * 顶部固定坞读「本轮」工具调用的纯函数：计划卡直接取本轮最后一次 plan:update，
 * 目标卡以宿主为权威、本轮 goal:* 一落定就重读。
 */
import { getGoalToolBlockSignature, isGoalToolStateToolName } from '../tool-render/goal/goalToolBlock'

import type { ChatMessage, ToolCallBlock } from '#contracts'
import { isConversationTurnInputMessage } from '#contracts'

/** 从最新消息往回找本轮（遇到开启新轮次的 turn-input 即止）最后一个匹配的工具调用。 */
export function getLatestCurrentTurnToolBlock(
  messages: readonly ChatMessage[],
  matchesToolName: (toolName: string) => boolean
): Nullable<ToolCallBlock> {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]

    if (isConversationTurnInputMessage(message)) return null
    if (message.role !== 'assistant') continue

    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.blocks[blockIndex]

      if (block.type === 'tool-call' && matchesToolName(block.toolName)) return block
    }
  }

  return null
}

/**
 * 目标生命周期要重读的时机：本轮最后一个 goal:create / goal:update 的内容或完成态变化。
 * 目标状态存在宿主里，而一轮进行中消息条数、运行状态都不变；不看这把钥匙，同轮里新建的目标要等
 * 整轮结束才出现在顶部，此时计划卡（直接取自工具调用）早已先上去了。
 */
export function getGoalLifecycleRefreshKey(messages: readonly ChatMessage[]): Nullable<string> {
  const block = getLatestCurrentTurnToolBlock(messages, isGoalToolStateToolName)
  if (!block) return null

  // 工具还在跑时参数里已有 objective，签名与完成后相同；带上完成时刻，落定后必然再读一次。
  return `${getGoalToolBlockSignature(block)}::${block.finishedAt ?? 'running'}`
}
