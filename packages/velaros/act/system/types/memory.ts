import type { ContextRecord, ContextRef } from '@velaros-ai/context'

import type { WorkspaceEntry } from './workspace.js'

/** 当前任务归档的有界查询，正文由 read 显式读取。 */
export interface MemoryQuery {
 /** 材料种类，默认全部。 */
 readonly kind?:'all'|'notes'|'inputs'|'programs'|'results'|'history'|'artifacts'
 /** 标题或笔记键关键词。 */
 readonly query?:string
 /** 上一页的记录序号。 */
 readonly after?:number
 /** 固定目录快照的结束序号。 */
 readonly through?:number
 /** 每页最多 64 项。 */
 readonly limit?:number
}
/** 目录返回真实原文位置及笔记版本。 */
export interface MemoryPage {
 /** 已授权的原始记录元数据。 */
 readonly items:ReadonlyArray<ContextRecord & Partial<WorkspaceEntry>>
 /** 下一页游标，结束时为空。 */
 readonly nextAfter:Nullable<number>
}
/** 主模型声明工作意图，窗口预算由宿主决定。 */
export interface MemoryOrganizeIntent {
 /** 接下来需要推进的工作。 */
 readonly focus?:string
 /** 本次整理必须保持可召回且不能释放租约的材料。 */
 readonly preserve?:readonly ContextRef[]
}
