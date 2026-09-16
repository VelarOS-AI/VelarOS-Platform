import { isBoolean } from '@velaros-ai/core'

import type { ToolCategoryId } from '../../types/agent.js'


/**
 * 定本次派发到底是不是只读：调用方显式给了布尔 override 就以它为准，
 * 没给（undefined）才回落到 sub-agent 类型配置的 readonlyDefault。
 * 注意 `false` 是有效的显式覆盖，不会被当成"没给"。
 */
function resolveReadonlyMode(readonlyDefault: boolean, override?: boolean): boolean {
  return isBoolean(override) ? override : readonlyDefault
}

/**
 * 只读模式下这个工具分类是否被禁：命中调用方传入的禁用分类集合即为真。
 * 判定只看分类不看单个工具名——只读边界按能力分类划，避免逐工具维护黑名单时漏网。
 */
function isBlockedInReadonlyMode(
  categoryId: ToolCategoryId,
  blockedCategoryIds: ReadonlySet<ToolCategoryId>
): boolean {
  return blockedCategoryIds.has(categoryId)
}

export { isBlockedInReadonlyMode, resolveReadonlyMode }
