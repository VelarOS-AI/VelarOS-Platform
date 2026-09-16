import { isFiniteNumber } from '@velaros-ai/core'

import { compareStableStrings } from '../residency/determinism'

/** P7-2：epoch 指纹里的清单序必须 locale 无关（码元序），否则同一份上下文跨机器判成"变了"。 */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    compareStableStrings
  )
}

export function normalizeLabel(value: string, fallback: string): string {
  return value.trim() || fallback
}

export function normalizeOptionalLabel(value: LooseOptional<string>): Nullable<string> {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

export function normalizeOptionalNonNegativeInteger(value: LooseOptional<number>): Nullable<number> {
  if (!isFiniteNumber(value) || value < 0) return null
  return Math.floor(value)
}

export function normalizeNonNegativeInteger(value: number): number {
  if (!isFiniteNumber(value)) return 0
  return Math.max(0, Math.floor(value))
}

export function normalizePercent(value: number): number {
  if (!isFiniteNumber(value)) return 0
  return Math.min(100, Math.max(0, value))
}
