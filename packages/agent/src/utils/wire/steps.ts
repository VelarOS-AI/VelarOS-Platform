import { isFiniteNumber } from '@velaros-ai/core'
import { clampRounded } from '@velaros-ai/core/utils/number'

export const MinExecutionStepCount = 1
export const MaxExecutionStepCount = 100
export const DefaultTeamWorkerStepCount = 50
export const DefaultTeamMaxStepCount = 300
export const MaxTeamStepCount = 1000

/**
 * 归一单次执行的最大步数：`value` 不是有限数（undefined / null / NaN / Infinity）时改用 `fallback`，
 * 两者最终都会过一遍 `clampExecutionStepCount`——所以连 `fallback` 本身越界也会被夹回区间，永不抛错。
 */
export function normalizeExecutionStepCount(
  value: LooseOptional<number>,
  fallback: number
): number {
  if (!isFiniteNumber(value)) return clampExecutionStepCount(fallback)

  return clampExecutionStepCount(value)
}

/**
 * 把单次执行步数四舍五入取整后夹进 [MinExecutionStepCount, MaxExecutionStepCount]（1..100）。
 * 越界不报错只夹取：上游传 0 或负数得 1，传 5000 得 100。
 */
export function clampExecutionStepCount(value: number): number {
  return clampRounded(value, MinExecutionStepCount, MaxExecutionStepCount)
}

/**
 * 归一 team（多 worker 协作）模式的总步数预算：语义同 `normalizeExecutionStepCount`，
 * 只是上限换成更宽的 MaxTeamStepCount，因为一个 team 的步数是所有 worker 摊下来的。
 */
export function normalizeTeamStepCount(
  value: LooseOptional<number>,
  fallback: number
): number {
  if (!isFiniteNumber(value)) return clampTeamStepCount(fallback)

  return clampTeamStepCount(value)
}

/**
 * 把 team 总步数取整后夹进 [MinExecutionStepCount, MaxTeamStepCount]（1..1000）——下限与单次执行共用，
 * 上限单独放宽。同样只夹取不抛错。
 */
export function clampTeamStepCount(value: number): number {
  return clampRounded(value, MinExecutionStepCount, MaxTeamStepCount)
}
