import type { ContextResourceTarget } from '@velaros-ai/context'

import { SearchLimits } from '../contract/constants.js'
import type { SearchRequest } from '../types.js'

/** 搜索请求的长度与数量核对：超出对外上限的直接拒绝，搜索不会开始。 */
export function checkSearchRequest(input: SearchRequest): void {
  if ((input.query?.length ?? 0) > SearchLimits.queryChars)
    throw searchInput(`query 最多 ${SearchLimits.queryChars} 个字符`)
  if ((input.context?.length ?? 0) > SearchLimits.contextChars)
    throw searchInput(`context 最多 ${SearchLimits.contextChars} 个字符`)
  if ((input.sources?.length ?? 0) > SearchLimits.sources)
    throw searchInput(`sources 最多 ${SearchLimits.sources} 个`)
  if ((input.anchors?.length ?? 0) > SearchLimits.anchors)
    throw searchInput(`anchors 最多 ${SearchLimits.anchors} 个`)
  for (const anchor of input.anchors ?? []) checkResourceTarget(anchor)
}

/** 资源目标的选择器核对：按行选择时行号从 1 数，且是整数。 */
export function checkResourceTarget(target: ContextResourceTarget): void {
  const selector = target.selector
  if (
    selector?.kind === 'lines' &&
    ![selector.start, selector.end].every((line) => Number.isSafeInteger(line) && line >= 1)
  )
    throw searchInput('按行选择的 start、end 从 1 数，而且是整数')
}

/** 搜索入参不合约定时的错误：发生在任何来源读取之前。 */
function searchInput(message: string): Error {
  return Object.assign(new Error(message), { code: 'SEARCH_INPUT' })
}
