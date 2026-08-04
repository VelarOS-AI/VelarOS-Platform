import { isString } from '@velaros-ai/core'
import { isEmpty, unique } from '@velaros-ai/core/utils/array'
import { isBlank } from '@velaros-ai/core/utils/string'

/** 上下文裁剪留下的深度占位串不是真 id，归一化时必须丢弃，否则会被当成一条谱系。 */
const DepthLimitPlaceholderPattern = /^\[Depth limit reached\b[^\]]*\]$/i

function normalizeSessionLineageId(value: LooseOptional<string>): string {
  if (!isString(value) || isBlank(value)) return ''

  const trimmed = value.trim()
  return DepthLimitPlaceholderPattern.test(trimmed) ? '' : trimmed
}

function normalizeSessionLineageIdList(
  values: LooseOptional<ReadonlyArray<LooseOptional<string>>>,
  fallback?: LooseOptional<string>
): string[] {
  const normalized = unique(
    (values ?? [])
      .map((value) => normalizeSessionLineageId(value))
      .filter((value) => !isEmpty(value))
  )
  if (!isEmpty(normalized)) return normalized

  const fallbackId = normalizeSessionLineageId(fallback)
  return isEmpty(fallbackId) ? [] : [fallbackId]
}

export { normalizeSessionLineageId, normalizeSessionLineageIdList }
