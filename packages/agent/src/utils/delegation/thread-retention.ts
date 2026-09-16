import type { ModelMessage } from 'ai'

import { isNotNull, sum } from '@velaros-ai/core'

import type { ThreadRetentionState } from '../../types/delegation.js'
import { estimateMessageChars } from '../residency/message-facts'

/**
 * 这条线程的历史有多少字符，用来判它值不值得留着续跑。
 *
 * 结果缓存在 `retention.historyChars` 上（回写历史时由调用方置回 null 作废），
 * 因为每次 prune 都要问一遍、而历史可能很长，重复统计会让清理随线程数平方级变慢。
 */
export function measureThreadHistoryChars(
  retention: ThreadRetentionState,
  history: readonly ModelMessage[]
): number {
  if (isNotNull(retention.historyChars)) return retention.historyChars
  const chars = sum(history, estimateMessageChars)
  retention.historyChars = chars
  return chars
}
