// 检索层各种上限的取值收敛：宿主传进来的数字可能是 undefined、NaN、小数或 0，这里统一成一个能用的正整数。
// 纯函数，不记状态，`ChatContextRetrievalService` 与 `ContextRetrievalQueryTraceStore` 在构造时逐项调用。

import { isFiniteNumber } from '@velaros-ai/core'

/**
 * 把一个可选的上限收敛成正整数：不是有限数字（undefined、null、NaN、Infinity）时退回 fallback，
 * 是数字则向下取整并至少保底 1——上限为 0 会让对应的表一条都存不下，那不是调小而是关掉，不允许这么配。
 */
export function normalizeRetrievalLimit(value: LooseOptional<number>, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback

  return Math.max(1, Math.floor(value))
}
