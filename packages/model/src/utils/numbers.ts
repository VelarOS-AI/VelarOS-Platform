/** unknown → 正整数，不是正整数就当缺席。 */
export function toPositiveInteger(value: unknown): Nullable<number> {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue) || numericValue <= 0) return null

  return Math.floor(numericValue)
}
