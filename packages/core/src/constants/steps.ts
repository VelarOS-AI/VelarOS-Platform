import { isFiniteNumber } from '../typeGuards.js'
export const MinExecutionStepCount = 1
export const MaxExecutionStepCount = 100
export const DefaultTeamWorkerStepCount = 50
export const DefaultTeamMaxStepCount = 300
export const MaxTeamStepCount = 1000

export function normalizeExecutionStepCount(
  value: LooseOptional<number>,
  fallback: number
): number {
  if (!isFiniteNumber(value)) return clampExecutionStepCount(fallback)

  return clampExecutionStepCount(value)
}

export function clampExecutionStepCount(value: number): number {
  return Math.min(MaxExecutionStepCount, Math.max(MinExecutionStepCount, Math.round(value)))
}

export function normalizeTeamStepCount(
  value: LooseOptional<number>,
  fallback: number
): number {
  if (!isFiniteNumber(value)) return clampTeamStepCount(fallback)

  return clampTeamStepCount(value)
}

export function clampTeamStepCount(value: number): number {
  return Math.min(MaxTeamStepCount, Math.max(MinExecutionStepCount, Math.round(value)))
}
