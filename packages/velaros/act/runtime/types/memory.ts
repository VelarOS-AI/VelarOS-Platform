import type { ContextReadStamp, ContextRef } from '@velaros-ai/context'

import type { WorkspaceEntry } from '../../system/types/workspace.js'

/** 各分区共享总窗口；份额只控制可裁剪正文，最终请求仍由编译器计量。 */
export interface ContextMemoryPolicy {
  /** 自动携带的近期记录条数，0–64，主任务默认 8，搜索默认 64。 */
  readonly recentRecords?: number
  /** 工作区正文的目标份额，0.05–0.5；空闲容量可被观察和结果使用。 */
  readonly workspaceShare?: number
  /** 近期记录正文的目标份额，0–0.5。 */
  readonly recentShare?: number
}

/** 工作笔记的不可变版本，内容始终标为模型解释。 */
export interface WorkspaceNote {
  readonly key: string
  readonly revision: number
  readonly title: string
  readonly body: string
  readonly sources: readonly ContextRef[]
  readonly resident: boolean
  readonly stamps: readonly ContextReadStamp[]
  readonly origin: 'model-note'
}

/** 宿主分页查看一个确定版本的工作笔记。 */
export interface RuntimeNoteRead {
  /** 当前笔记的稳定键。 */
  readonly key: string
  /** 列举时获得的版本；过期请求明确报冲突。 */
  readonly revision: number
  /** 正文起始字符，默认从头读取。 */
  readonly offset?: number
  /** 本页字符上限。 */
  readonly limit?: number
}
/** 只调整工作笔记驻留，保留正文与历史版本。 */
export interface RuntimeNoteRetention {
  /** 当前笔记稳定键。 */
  readonly key: string
  /** 变更所依据的版本。 */
  readonly baseRevision: number
  /** 是否参与后续请求的工作区投影。 */
  readonly resident: boolean
}
/** 经过范围校验的笔记正文页。 */
export interface RuntimeNoteContent {
  /** 当前笔记的身份及版本。 */
  readonly entry: WorkspaceEntry
  /** 当前页正文。 */
  readonly text: string
  /** 正文总字符数。 */
  readonly totalChars: number
  /** 本页起始位置。 */
  readonly offset: number
}
