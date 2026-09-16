// ExecutionGuidanceQueue 用到的纯函数（不碰实例状态）。
import type { ModelMessage } from 'ai'

import { isBlank, isNonEmptyArray, isString } from '@velaros-ai/core'

/** 这条消息是否是用户看得见的引导（只认非空的 user 消息）。 */
export function hasUserVisibleGuidance(message: ModelMessage): boolean {
  if (message.role !== 'user') return false

  if (isString(message.content)) return !isBlank(message.content.trim())

  return isNonEmptyArray(message.content)
}
