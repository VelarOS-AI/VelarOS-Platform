import { isBoolean } from '@velaros-ai/core'

import type { ToolCategoryId } from '../protocol/types/tool'

function resolveReadonlyMode(readonlyDefault: boolean, override?: boolean): boolean {
  return isBoolean(override) ? override : readonlyDefault
}

function isBlockedInReadonlyMode(
  categoryId: ToolCategoryId,
  blockedCategoryIds: ReadonlySet<ToolCategoryId>
): boolean {
  return blockedCategoryIds.has(categoryId)
}

export { isBlockedInReadonlyMode, resolveReadonlyMode }
