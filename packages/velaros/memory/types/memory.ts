/**
 * 长期记忆的可移植数据：`velaros:memory` 的入参与回执（带 @AgentView 的那些），以及管理页用的作用域概况。
 * 只从常量表 import 类型、不带函数成员、不用 Node 专属类型，整个文件随 `./memory/contracts` 入口出单元（渲染进程可加载）。
 */

import type { MemoryTypes } from '../contract/constants.js'

/** @AgentView user 用户、feedback 反馈、work 工作、reference 参考。 */
export type MemoryType = (typeof MemoryTypes)[number]

/** @AgentView 一条记忆。tags 是主题标签；updatedAt 是 ISO 时间，字符串直接比大小就是比先后。 */
export interface MemoryEntry {
  id: string
  type: MemoryType
  title: string
  description: string
  tags: string[]
  content: string
  updatedAt: string
}

/**
 * @AgentView
 * 写一条：id 用小写字母、数字和连字符，最多 64 个字符；标题最多 100 个字符、描述最多 200 个字符，两者都不换行；正文最多 20000 个字符。
 * tags 不给就沿用这条原来的标签（新建的就是没有），给 [] 才清空；给的话最多 8 个，每个最多 32 个字符、不含逗号和换行，存的时候转小写、去重。
 */
export interface MemorySaveInput {
  id: string
  type: MemoryType
  title: string
  description: string
  tags?: string[]
  content: string
}

/** @AgentView 写下了：created 为假，说明覆盖的是已有的那一条。 */
export interface MemorySaved {
  id: string
  created: boolean
}

/** @AgentView 要删的那一条。 */
export interface MemoryIdInput {
  id: string
}

/** @AgentView 删的结果：本来就没有这一条时 removed 为假。 */
export interface MemoryRemoved {
  removed: boolean
}

/** 一个有记忆的作用域：作用域字符串原样、里面有几条、最近一次更新（ISO 时间）。给宿主的管理页用，不进模型面。 */
export interface MemoryScopeSummary {
  scope: string
  count: number
  updatedAt: string
}
