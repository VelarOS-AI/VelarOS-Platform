import type { ContextContent, ContextRecord, ContextRef } from '@velaros-ai/context'
import type { MemoryEntry } from '@velaros-ai/velaros/memory'

import type { ScriptRetention } from './results.js'
import type { WorkspaceEntry } from './workspace.js'

/**
 * 当前任务归档的有界查询，正文由 read 显式读取。
 * @AgentView
 * 查当前任务的材料目录：kind 按种类筛（notes 笔记、inputs 用户输入、programs 脚本、results 执行结果、history 回复与结果、artifacts 交付物），默认全部；
 * query 按标题关键词筛；after 是上一页的 nextAfter，through 固定目录快照的结束序号；limit 每页最多 64 项。
 */
export interface MemoryQuery {
  readonly kind?: 'all' | 'notes' | 'inputs' | 'programs' | 'results' | 'history' | 'artifacts'
  readonly query?: string
  readonly after?: number
  readonly through?: number
  readonly limit?: number
}
/** @AgentView 目录里的一份材料：原文元数据；是笔记时还带着 key、revision（改它时作为 baseRevision 交回）与 resident。 */
export interface MemoryListItem extends ContextRecord {
  readonly key?: string
  readonly revision?: number
  readonly resident?: boolean
}
/**
 * 目录返回真实原文位置及笔记版本。
 * @AgentView
 * 材料目录的一页；nextAfter 不是 null 就把它当 after 接着翻。
 */
export interface MemoryPage {
  readonly items: readonly MemoryListItem[]
  readonly nextAfter: Nullable<number>
}
/** @AgentView 按引用读一页原文：ref 是目录里的引用（或它的 id），offset、limit 按 UTF-16 字符算，一页最多 60000 个字符。读取不续租、不重跑脚本。
 * 补读执行结果或当前决策状态归档中的字段时传展示给出的 pointer（JSON Pointer，以 / 开头，最多 4096 个字符）；字符串返回原文，其他值返回 JSON，offset 与 limit 针对选中字段。省略 pointer 时读整份归档。
 * 脚本失败后，先按 progress.feedback.recovery.index 读取调用索引；invocation 填索引中的 id，ref 仍为该失败脚本结果。此时读的是原始调用回执（outcome/effect/value/error），pointer 针对该回执；省略 pointer 读整份回执。未落定的调用明确不可用，不会重跑。
 */
export interface MemoryReadInput {
  readonly ref: string | ContextRef
  readonly invocation?: string
  readonly pointer?: string
  readonly offset?: number
  readonly limit?: number
}
/** @AgentView 读到的一页原文；有 pointer 时 text、offset、totalChars 属于选中字段，record 仍标识完整归档。字符串字段不带 JSON 引号，其他字段为 JSON。
 * 补齐必需输出块时，使用 runtime.decision.missing 的 read 输入从 offset 0 读该块，逐页原样 output(page, {key:唯一键,view:{mode:'full'}})。
 * delivery 是宿主绑定的交付回执，不要改写；只有完整页对象的正文实际完整进入当前模型历史才计入原块的交付证明。
 * 下一页 offset 为 page.offset + page.text.length；同一块 value pointer 或省略 pointer 的整份归档，只有本次历史中完整页的字符范围连续覆盖全文才核销。
 * 读取本身、只输出 page.text、局部字段或尚有缺页都不核销原块缺口；展示额度不足时分批交付，原文仍按原引用召回，不自动 release。
 */
export interface MemoryContent extends ContextContent {
  readonly pointer?: string
  /** 调用召回回显；此类页不会签发必需输出块的 delivery 证明。 */
  readonly invocation?: string
  readonly delivery?: { readonly receipt: ContextRef }
}
/** @AgentView 保留一份笔记或执行结果的自动展示：结果按 turns 续租（不给是 task），笔记一直驻留到主动 release。 */
export interface MemoryRetainInput {
  readonly ref: string | ContextRef
  readonly turns?: ScriptRetention
}
/** @AgentView 释放一份笔记或执行结果的自动展示；原文仍然可以 read。 */
export interface MemoryReleaseInput {
  readonly ref: string | ContextRef
}
/** @AgentView 执行结果续租了：remainingTurns 是还会自动展示多少个成功回合，segment 表示到该结果随历史封段，task 表示到任务结束；executed 为假，脚本没有重跑。 */
export interface ResultRetained {
  readonly ref: string
  readonly remainingTurns: ScriptRetention
  readonly executed: false
}
/** @AgentView 执行结果不再自动展示；executed 为假，脚本没有重跑。 */
export interface ResultReleased {
  readonly ref: string
  readonly released: true
  readonly executed: false
}
/** @AgentView 调整驻留的结果：笔记交回它的当前版本，执行结果交回租约。 */
export type MemoryRetention = WorkspaceEntry | ResultRetained | ResultReleased
/**
 * 主模型声明工作意图，窗口预算由宿主决定。
 * @AgentView
 * 安排一次整理：focus 是接下来要推进的工作（1 到 3000 个字符），preserve 是这次整理必须保持可召回、不能释放的原文引用（最多 64 条）。
 */
export interface MemoryOrganizeIntent {
  readonly focus?: string
  readonly preserve?: readonly ContextRef[]
}
/** @AgentView 整理已经排上队：在下一次模型请求之前进行，结果出现在下一帧的 memoryStatus.maintenance。 */
export interface MemoryOrganizeReceipt {
  readonly requestId: string
  readonly taskId: string
  readonly status: 'scheduled'
  readonly focus: string
  readonly preserve: readonly ContextRef[]
  readonly boundary: 'next-model-request'
}
/** @AgentView 召回长期记忆：id 精确取一条；query 按 id、标题、描述、标签与正文匹配关键词；按 offset 翻页，limit 默认 8、最多 32。 */
export interface LongTermMemoryQuery {
  readonly id?: string
  readonly query?: string
  readonly offset?: number
  readonly limit?: number
}
/** @AgentView 召回到的长期记忆，含正文；total 是全部匹配的条数，nextOffset 不是 null 就接着翻。 */
export interface LongTermMemoryPage {
  readonly items: readonly MemoryEntry[]
  readonly total: number
  readonly nextOffset: Nullable<number>
}
