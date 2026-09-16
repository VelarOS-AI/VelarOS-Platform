// AgentLoopContextUsageManager 用到的纯函数（不碰实例状态）。
import { isFiniteNumber } from '@velaros-ai/core'

import type { AgentModelRequestOptions } from '../../contract/requires.js'
import type { EstimateContextUsageOptions } from '../../types/context.js'

/** 本轮显式输出上限与实际请求策略同源，覆盖按窗口比例推导的缺省预留。 */
export function resolveModelContextUsageOptions(
  options: EstimateContextUsageOptions = {},
  modelRequestOptions?: LooseOptional<AgentModelRequestOptions>
): EstimateContextUsageOptions {
  const maxOutputTokens = modelRequestOptions?.requestPolicy?.maxOutputTokens
  if (!isFiniteNumber(maxOutputTokens) || maxOutputTokens < 0) return options
  return { ...options, reservedOutputTokens: maxOutputTokens }
}
