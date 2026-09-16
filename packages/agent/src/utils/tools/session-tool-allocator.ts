import { isEmpty } from '@velaros-ai/core'

import type { ToolCategoryId } from '../../types/agent.js'
import type { ToolAllocatorCategory, ToolAllocatorDenialCode, ToolAllocatorDeniedRequest, ToolAllocatorFuseState, ToolAllocatorOperation, ToolAllocatorRequest, ToolAllocatorRuntimeIndex } from '../../types/tools.js'

/**
 * 造一条「这次工具申请没给」的拒绝记录（操作 + 类别 + 拒绝码 + 给模型看的原因）。
 * 只是字面量构造器，不判定该不该拒；这些记录后续会被 dedupeDeniedRequests 去重、被 buildAllocationMessage 摊成给模型的结论文案。
 */
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

/**
 * 把任意可迭代的字符串收成去重数组，保留首次出现的顺序；按严格相等去重，不做 trim 或大小写归一。
 */
export function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

/**
 * `uniqueStrings` 的类别 id 版：去重并保留首次出现顺序，只为让发放清单里的类别 id 保持 `ToolCategoryId` 类型不被拓宽成 string。
 */
export function uniqueToolCategoryIds(values: Iterable<ToolCategoryId>): ToolCategoryId[] {
  return [...new Set(values)]
}

/**
 * 把自由文本压成可比较的形态：去首尾空白、连续空白折成单个空格、整体转小写。
 * 申请指纹（buildRequestSignature）靠它把「换个说法重申一遍同一件事」认成同一条，熔断计数才绕不过去。
 */
export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * 把本轮运行态的类别清单摊成两份索引：类别 → 工具列表、以及全部工具名的集合。
 * 发放时按类别取工具，基础驻留工具要按工具名核对「运行态真有这个工具」，两处都查这份索引。
 */
export function buildRuntimeToolIndex<TTool extends { name: string }>(
  categories: ReadonlyArray<ToolAllocatorCategory<TTool>>
): ToolAllocatorRuntimeIndex<TTool> {
  const categoryMap = new Map<ToolCategoryId, TTool[]>()
  const toolNames = new Set<string>()

  for (const category of categories) {
    const visibleTools: TTool[] = []
    for (const tool of category.tools) {
      visibleTools.push(tool)
      toolNames.add(tool.name)
    }
    categoryMap.set(category.category.id, visibleTools)
  }

  return { categoryMap, toolNames }
}

/**
 * 去掉重复的拒绝项：同一次申请里多个操作命中同一个类别会各记一条，
 * 按「操作 + 类别 + 代码 + 文案」四元组认同一条，只留最先出现的那份，保持顺序。
 */
export function dedupeDeniedRequests(
  deniedRequests: readonly ToolAllocatorDeniedRequest[]
): ToolAllocatorDeniedRequest[] {
  const seen = new Set<string>()
  const result: ToolAllocatorDeniedRequest[] = []
  for (const denied of deniedRequests) {
    const key = [
      denied.operation,
      denied.categoryId,
      denied.code,
      denied.message,
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(denied)
  }
  return result
}

/**
 * 给一次申请算身份指纹：意图归一化、操作与目标排序后拼起来。
 * 熔断按它计数——换个说法、调个顺序重申请同一件事仍算同一条，绕不过去。
 */
export function buildRequestSignature(request: ToolAllocatorRequest): string {
  return [
    normalizeText(request.intent),
    request.operations.map((operation) => operation.trim()).sort().join(','),
    [...(request.targets ?? [])].map(normalizeText).sort().join(','),
  ].join('|')
}

/**
 * 拼给模型看的发放结论：熔断时只说熔断原因；什么都没发也没拒时说明保留基础驻留工具；
 * 否则分别列出发放的类别和未发放项（带类别、代码与原因）。
 */
export function buildAllocationMessage(input: {
  grantedCategoryIds: readonly ToolCategoryId[]
  deniedRequests: readonly ToolAllocatorDeniedRequest[]
  fuse: ToolAllocatorFuseState
}): string {
  if (input.fuse.tripped) return input.fuse.message ?? '工具申请已熔断。'
  const granted = uniqueToolCategoryIds(input.grantedCategoryIds)
  if (isEmpty(granted) && isEmpty(input.deniedRequests)) return '工具分配器保留基础驻留工具，本轮没有额外发放。'
  const parts: string[] = []
  if (!isEmpty(granted)) {
    parts.push(`已发放工具分类：${granted.join(', ')}。`)
  }
  if (!isEmpty(input.deniedRequests)) {
    parts.push(
      `未发放：${input.deniedRequests
        .map((item) => `${item.categoryId}/${item.code}${item.message ? `：${item.message}` : ''}`)
        .join(', ')}。`
    )
  }
  return parts.join(' ')
}
