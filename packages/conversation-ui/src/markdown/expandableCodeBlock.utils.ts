export const EXPANDABLE_CODE_BLOCK_INITIAL_VISIBLE_LINES = 12
export const EXPANDABLE_CODE_BLOCK_LINE_GROWTH_FACTOR = 2

export function getEffectiveCodeBlockTotalLines({
  measuredTotalLines,
  totalLines,
}: {
  measuredTotalLines?: LooseOptional<number>
  totalLines: number
}): number {
  const normalizedMeasuredLines =
    Number.isFinite(measuredTotalLines) && measuredTotalLines ? Math.ceil(measuredTotalLines) : 0

  return Math.max(totalLines, normalizedMeasuredLines)
}

export function countCodeBlockLines(code: string): number {
  const normalized = code.replace(/\r\n|\r/gu, '\n').replace(/\n+$/u, '')

  if (!normalized) return 1

  return normalized.split('\n').length
}

export function shouldCollapseCodeBlock({
  isStreaming = false,
  measuredTotalLines,
  totalLines,
  visibleLines,
}: {
  isStreaming?: boolean
  measuredTotalLines?: LooseOptional<number>
  totalLines: number
  visibleLines: number
}): boolean {
  if (isStreaming) return false

  return getEffectiveCodeBlockTotalLines({ measuredTotalLines, totalLines }) > visibleLines
}

export function shouldShowCodeBlockCollapseButton({
  isStreaming = false,
  measuredTotalLines,
  totalLines,
  visibleLines,
}: {
  isStreaming?: boolean
  measuredTotalLines?: LooseOptional<number>
  totalLines: number
  visibleLines: number
}): boolean {
  if (isStreaming) return false

  const effectiveTotalLines = getEffectiveCodeBlockTotalLines({ measuredTotalLines, totalLines })

  return (
    effectiveTotalLines > EXPANDABLE_CODE_BLOCK_INITIAL_VISIBLE_LINES &&
    visibleLines >= effectiveTotalLines
  )
}

export function getNextVisibleCodeBlockLines({
  measuredTotalLines,
  totalLines,
  visibleLines,
}: {
  measuredTotalLines?: LooseOptional<number>
  totalLines: number
  visibleLines: number
}): number {
  const effectiveTotalLines = getEffectiveCodeBlockTotalLines({ measuredTotalLines, totalLines })
  const normalizedVisibleLines = Math.max(visibleLines, 0)
  const exponentialVisibleLines = Math.max(
    normalizedVisibleLines + 1,
    normalizedVisibleLines * EXPANDABLE_CODE_BLOCK_LINE_GROWTH_FACTOR
  )

  return Math.min(effectiveTotalLines, exponentialVisibleLines)
}
