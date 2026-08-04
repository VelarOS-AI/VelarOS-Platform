import type { ToolCategoryId } from '@velaros-ai/agent/protocol'
import { isBoolean } from '@velaros-ai/core'

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
