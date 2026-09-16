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

/**
 * 把续跑身份字段（resource_id、model 等）归一成可直接相等比较的串：去首尾空白，缺席统一成 `''`。
 * 这样「没写」与「写了空串」被当成同一种身份，不会因为其中一侧缺省就误判成"换了资源/换了模型"而拒绝续跑。
 */
export function normalizeResumeIdentityString(value: LooseOptional<string>): string {
  return value?.trim() ?? ''
}

/** 工具分类去重（保序）。只做去重——不做展开、不做只读收窄，那两件事分别归类型配置与执行门。 */
export function dedupeToolCategories(categories: readonly ToolCategoryId[]): ToolCategoryId[] {
  return [...new Set<ToolCategoryId>(categories)]
}

/**
 * 两个字符串数组是否是同一个集合：长度相同且左侧每项都在右侧出现，顺序无关。
 * 续跑校验用它比对工具分类——分类的书写顺序不是语义，换个顺序不该被判成"授权变了"。
 * 注意它按集合比：左侧有重复项时长度不同会先被挡下，但同样长度的重复组合不做多重集区分。
 */
export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((item) => rightSet.has(item))
}
