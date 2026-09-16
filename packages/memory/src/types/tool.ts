/** 四个记忆工具的入参形状（模型面 schema 的 TypeScript 映射）。 */

import type { MemoryEvidenceCategories, MemoryEvidenceCategoryAliases } from '../contract/constants'

import type { MemoryForgetResult, MemoryRecallItem } from './memory'

/** 工具入参边界上认的类别：正式类别加三个旧别名。 */
export type MemoryToolCategory =
  | (typeof MemoryEvidenceCategories)[number]
  | keyof typeof MemoryEvidenceCategoryAliases

/** `memory:save` 的入参。 */
export interface SaveMemoryInput extends Record<string, unknown> {
  /** 记忆类别。 */
  kind: MemoryToolCategory
  /** 这条记忆的简短主题。 */
  title: string
  /** 要记住的内容正文。 */
  content: string
  /** 可选的人类可读摘要。 */
  summary?: string
  /** 可选来源说明。 */
  source?: string
  /** 可选标签，只作为记忆元数据。 */
  tags?: string[]
  /** 可选工作区根；缺省从当前项目空间派生。 */
  workspaceRoot?: string
  /** 可选任务稳定键。 */
  taskKey?: string
  /** 可选隐私级。 */
  privacyClass?: 'standard' | 'personal' | 'sensitive'
}

/** `memory:search` 的入参。 */
export interface SearchMemoriesInput extends Record<string, unknown> {
  /** 查询词；search 模式必填。 */
  query?: string
  /** 检索、浏览还是画像。 */
  mode?: 'search' | 'browse' | 'profile'
  /** 返回多少条。 */
  limit?: number
  /** 可选工作区根。 */
  workspaceRoot?: string
  /** 是否把已归档的一并翻出来。 */
  deep?: boolean
  /** 只要这些类别。 */
  categories?: MemoryToolCategory[]
}

/** `memory:get` 的入参。 */
export interface GetMemoryInput extends Record<string, unknown> {
  /** `memory:search` 返回的条目 id。 */
  id: string
}

/** `memory:archive` 的入参。 */
export interface ForgetMemoryInput extends Record<string, unknown> {
  /** `memory:search` 返回的条目 id。 */
  id: string
  /** 归档理由，只写入本次工具结果。 */
  reason?: string
}

/** `memory:save` 的回执。 */
export interface SaveMemoryResult extends Record<string, unknown> {
  /** 固定为 true：走到这里说明后端收下了。 */
  accepted: true
  /** 这次是新写入还是按来源幂等命中了已有条目。 */
  inserted: boolean
  /** 写下的条目 id。 */
  memoryId: string
  /** 什么时候可被召回：immediate = 已可召回，consolidating = 由后台整理择时纳入。 */
  availability: 'consolidating' | 'immediate'
  /** 给模型看的一句话回执。 */
  message: string
  /** 树档才有的版本号；没有整理管线的后端不带这个键。 */
  treeVersion?: number
}

/** `memory:search` 的回执。 */
export interface SearchMemoriesResult extends Record<string, unknown> {
  /** 这次用的是哪种模式。 */
  mode: string
  /** 实际拿去检索的查询词（画像模式为空串）。 */
  query: string
  /** 返回了多少条。 */
  count: number
  /** 投影成紧凑形状的记忆条目。 */
  memories: Array<Record<string, unknown>>
}

/** `memory:get` 的回执。 */
export interface GetMemoryResult extends Record<string, unknown> {
  /** 读到的那一条记忆（全文与来源）。 */
  memory: MemoryRecallItem
}

/** `memory:archive` 的回执：后端的归档结果，外加如实的归没归成与措辞。 */
export type ForgetMemoryResult = MemoryForgetResult & {
  /** 后端真的归档到了没有；只读根会是 false。 */
  archived: boolean
  /** 固定为 false：归档从不物理删除。 */
  physicalDelete: false
  /** 模型给的归档理由，只回显在本次结果里。 */
  reason: Nullable<string>
  /** 给模型看的一句话回执。 */
  message: string
}
