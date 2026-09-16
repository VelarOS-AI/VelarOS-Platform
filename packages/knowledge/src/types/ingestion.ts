/** 摄入层的数据形状：工作区文件快照、准备好的文档、代码候选、路径平台与目录读取口。 */

import type { KnowledgeSourceKind, KnowledgeUpsertInput } from './knowledge.js'

/** 工作区里一个可索引文件的文件系统快照。 */
export interface KnowledgeWorkspaceFileEntry {
  workspaceRoot: string
  absolutePath: string
  path: string
  sourceKind: KnowledgeSourceKind
  fileSize: number
  modifiedAt: number
}

/** 已读取并转换成知识写入结构的一份文档。 */
export interface KnowledgeWorkspacePreparedDocument {
  file: KnowledgeWorkspaceFileEntry
  document: KnowledgeUpsertInput
  contentHash: string
}

/** 代码候选和普通 prepared document 结构一致，只是来源与选择策略不同。 */
export interface KnowledgeWorkspaceCodeCandidate extends KnowledgeWorkspacePreparedDocument {}

/** 判断已索引文件是否仍存在且可索引的结果。 */
export interface KnowledgeIndexedFileInspection {
  exists: boolean
  indexable: boolean
}

/** 选择代码候选的入参。 */
export interface KnowledgeCodeCandidateInput {
  workspaceRoot: string
  pathHints: string[]
  symbolHints: string[]
  limit?: number
}

/** 带排序分数的代码候选。 */
export interface KnowledgePathSearchCandidate {
  candidate: KnowledgeWorkspaceCodeCandidate
  score: number
}

/** 从 path hint 推导出的代码关系信号。 */
export interface KnowledgeCodeSignalContext {
  directHintPaths: Set<string>
  importedTargetPaths: Set<string>
}

/** 一次代码候选同步的结果，额外返回本次可参与搜索的候选文档 id。 */
export interface KnowledgeCodeSyncResult {
  workspaceRoot: string
  candidateIds: string[]
  scanned: number
  upserted: number
  reindexed: number
  reindexBlocked: number
  removed: number
  skipped: number
}

/** 单个文件同步之后的结果分类。 */
export type KnowledgeSyncOutcome = 'upserted' | 'reindexed' | 'reindex-blocked' | 'skipped'

/** 一次扫描过程中已经看过多少个代码文件的计数器。 */
export interface KnowledgeCodeScanState {
  scannedFiles: number
}

/** 路径判定用到的平台原语，测试可以注入一份 Windows 语义的实现。 */
export interface KnowledgePathPlatform {
  isAbsolute(path: string): boolean
  relative(from: string, to: string): string
  resolve(...paths: string[]): string
  sep: string
}

/** 摄入层读目录、读文件、看属性的最小文件系统口。 */
export interface KnowledgeDocumentFileSystem {
  listDirectory: (path: string) => Promise<KnowledgeDirectoryEntry[]>
  read: (path: string) => Promise<Buffer>
  inspect: (path: string) => Promise<KnowledgeFileStats>
}

/** 目录里的一项：名字加上它是什么。 */
export interface KnowledgeDirectoryEntry {
  name: string
  isDirectory: () => boolean
  isFile: () => boolean
  isSymbolicLink: () => boolean
}

/** 一个文件的属性读数。 */
export interface KnowledgeFileStats {
  size: number
  mtimeMs: number
  isFile: () => boolean
  isDirectory: () => boolean
}
