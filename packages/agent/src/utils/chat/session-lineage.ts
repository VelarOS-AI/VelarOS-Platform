import { isString } from '@velaros-ai/core'
import { isEmpty, unique } from '@velaros-ai/core/utils/array'
import { isBlank } from '@velaros-ai/core/utils/string'

/** 上下文裁剪留下的深度占位串不是真 id，归一化时必须丢弃，否则会被当成一条谱系。 */
const DepthLimitPlaceholderPattern = /^\[Depth limit reached\b[^\]]*\]$/i

/**
 * 归一一个会话谱系 id：非字符串或全空白返回空串，否则去首尾空白后返回。
 * 另外单独挡掉上下文裁剪留下的 `[Depth limit reached …]` 占位串——它长得像 id 但不是，
 * 放过去就会凭空多出一条谱系，把不相干的会话串成父子。
 * 返回空串即"这里没有有效 id"，调用方据此丢弃，而不是把空串当成一条谱系。
 */
function normalizeSessionLineageId(value: LooseOptional<string>): string {
  if (!isString(value) || isBlank(value)) return ''

  const trimmed = value.trim()
  return DepthLimitPlaceholderPattern.test(trimmed) ? '' : trimmed
}

/**
 * 归一一整串会话谱系 id：逐个走 {@link normalizeSessionLineageId}，丢掉空值再按首次出现序去重。
 * 清单归一后一条不剩时才回落 `fallback`（同样要过归一）；fallback 也无效就返回空数组。
 * 注意回落是"全空才用"，不是"补进去"——只要清单里还有一条有效 id，fallback 就不参与，避免把一个兜底 id 混进真实谱系里。
 */
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
