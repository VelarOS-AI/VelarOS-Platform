import { isArray, isEmpty } from '@velaros-ai/core'

import type { TeamModelSelectionTrace, ToolCategoryId } from '../../types/agent.js'

/** 主 Agent 指定的模型不在同厂商可选列表里时，给结果正文补一句：本次沿用了什么、可以选什么。 */
export function formatModelFallbackNote(trace: LooseOptional<TeamModelSelectionTrace>): Nullable<string> {
  if (trace?.reason !== 'requested-model-unavailable') return null
  const requested = trace.metadata?.requestedModel
  const selectable = trace.metadata?.selectableModels
  const options =
    isArray(selectable) && !isEmpty(selectable) ? `可选：${selectable.join('、')}。` : ''
  return `（指定的模型「${String(requested)}」不在当前厂商的可选列表中，本次沿用主模型「${trace.model}」。${options}）`
}

export function normalizeResumeIdentityString(value: LooseOptional<string>): string {
  return value?.trim() ?? ''
}

/** 工具分类去重（保序）。只做去重——不做展开、不做只读收窄，那两件事分别归类型配置与执行门。 */
export function dedupeToolCategories(categories: readonly ToolCategoryId[]): ToolCategoryId[] {
  return [...new Set<ToolCategoryId>(categories)]
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((item) => rightSet.has(item))
}
