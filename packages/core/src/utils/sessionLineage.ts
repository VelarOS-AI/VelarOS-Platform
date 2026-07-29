import { unique } from './array.js'
const DepthLimitPlaceholderPattern = /^\[Depth limit reached\b[^\]]*\]$/i

function normalizeSessionLineageId(value: LooseOptional<string>): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (DepthLimitPlaceholderPattern.test(trimmed)) return ''
  return trimmed
}

function normalizeSessionLineageIdList(
  values: LooseOptional<ReadonlyArray<LooseOptional<string>>>,
  fallback?: LooseOptional<string>
): string[] {
  const sourceValues = values && values.length > 0 ? values : []
  const normalized = unique(sourceValues
    .map((value) => normalizeSessionLineageId(value))
    .filter((value) => value.length > 0))
  if (normalized.length > 0) return normalized

  const fallbackId = normalizeSessionLineageId(fallback)
  return fallbackId ? [fallbackId] : []
}

export { normalizeSessionLineageId, normalizeSessionLineageIdList }
