import type { ToolCategoryId } from '../../types/agent.js'
import type { ToolAllocatorDenialCode, ToolAllocatorDeniedRequest, ToolAllocatorOperation } from '../../types/tools.js'

export function createDeniedRequest(input: {
  operation: ToolAllocatorOperation
  categoryId: ToolCategoryId
  code: ToolAllocatorDenialCode
  message: string
}): ToolAllocatorDeniedRequest {
  return {
    operation: input.operation,
    categoryId: input.categoryId,
    code: input.code,
    message: input.message,
  }
}

export function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

export function uniqueToolCategoryIds(values: Iterable<ToolCategoryId>): ToolCategoryId[] {
  return [...new Set(values)]
}

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}
