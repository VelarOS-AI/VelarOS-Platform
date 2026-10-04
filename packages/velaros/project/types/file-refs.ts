/**
 * 文件引用的记录：源码快照、可编辑视图（fileRef）与改动回执。
 * 记录按会话存在进程内存里，完整哈希校验记录，8 位短身份定位记录；只在包内用，模型只见到引用字符串。
 */

/** 一段可见范围：从哪个偏移到哪个偏移、第几行到第几行，是不是整行。 */
export interface ProjectVisibleCoverage {
  startOffset: number
  endOffset: number
  startLine: number
  endLine: number
  completeLines: boolean
}

/** fileRef 背后的视图：路径（相对引擎根）、版本、正文与可见范围。 */
export interface ProjectFileView {
  path: string
  revision: string
  contentRevision: string
  content: string
  coverage: ProjectVisibleCoverage[]
}

/** 一份源码快照：签发它的引擎根、路径、版本与完整正文。快照本身不带编辑权。 */
export interface SourceRecord {
  kind: 'project-file-source'
  version: 1
  root: string
  path: string
  revision: string
  contentRevision: string
  content: string
}

/** 一个可编辑视图：指向一份源码快照，带着实际显示过的范围。 */
export interface ViewRecord {
  kind: 'project-file-view'
  version: 1
  source: string
  coverage: ProjectVisibleCoverage[]
}

/** 一张回执（改动）：签发它的引擎根与内容。 */
export interface ReceiptRecord {
  kind: 'project-receipt'
  version: 1
  receipt: string
  root: string
  value: unknown
}

/** 引用背后的任何一种记录。 */
export type RefRecord = SourceRecord | ViewRecord | ReceiptRecord

/** 一个会话的引用记录：按最近使用排序，另记着总字符数（超了从最旧的删起）。 */
export interface RefSession {
  records: Map<string, { record: RefRecord; chars: number }>
  /** 短引用至完整内容身份；记录淘汰后仍占用，防止旧引用误命中新记录。 */
  aliases: Map<string, string>
  references: Map<string, string>
  /** 已消费的失败计划，轻量墓碑防止重放。 */
  consumed: Set<string>
  chars: number
}
