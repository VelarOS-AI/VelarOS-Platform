import type { ProjectTextEncoding } from '../types/text.js'

/** Coordinates always refer to the immutable source supplied by the resolver. */
export type ProjectLineRange = number | readonly [number] | readonly [number, number]

export interface ProjectVisibleCoverage {
  startOffset: number
  endOffset: number
  startLine: number
  endLine: number
  completeLines: boolean
}

export interface ProjectEditView {
  path: string
  revision: string
  content: string
  coverage: readonly ProjectVisibleCoverage[]
}

export type ProjectContentEdit =
  | { op: 'replace'; range?: ProjectLineRange; match?: string; text: string }
  | { op: 'insert'; range?: ProjectLineRange; match?: string; side: 'before' | 'after'; text: string }
  | { op: 'insert'; at: 'start' | 'end'; text: string }

export interface ProjectEditFile {
  fileRef: string
  edits: readonly ProjectContentEdit[]
}

export interface ProjectEditInput {
  files: readonly ProjectEditFile[]
}

export type ProjectRecodeEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
export type ProjectRecodeNewline = 'lf' | 'crlf'

/** 批量改写磁盘编码、BOM 与物理换行；Unicode 正文不变，按路径而非 fileRef 指定。 */
export interface ProjectRecodeAction {
  op: 'recode'
  paths: readonly string[]
  encoding?: ProjectRecodeEncoding
  bom?: boolean
  newline?: ProjectRecodeNewline
}

export type ProjectFileAction =
  | { op: 'create'; path: string; text: string }
  | { op: 'overwrite'; fileRef: string; text: string }
  | { op: 'move'; fileRef: string; to: string }
  | { op: 'delete'; fileRef: string }
  | ProjectRecodeAction

export interface ProjectFileInput {
  actions: readonly ProjectFileAction[]
}

/** sourceRef follows a file identity through prior plan steps; path names a plan-created file. */
export type ProjectPlanSource = { fileRef: string } | { sourceRef: string } | { path: string }
export type ProjectPlanFileAction =
  | { op: 'create'; path: string; text: string }
  | ({ op: 'overwrite'; text: string } & ProjectPlanSource)
  | ({ op: 'move'; to: string } & ProjectPlanSource)
  | ({ op: 'delete' } & ProjectPlanSource)
  | ProjectRecodeAction

export type ProjectChangeStep =
  | { tool: 'file'; actions: readonly ProjectPlanFileAction[] }
  | { tool: 'edit'; files: ReadonlyArray<ProjectPlanSource & { edits: readonly ProjectContentEdit[] }> }

export interface ProjectChangeApplyInput {
  action: 'apply'
  steps: readonly ProjectChangeStep[]
}

/** readPath observes destination existence, and returns a revision even for an absent path. */
export interface ProjectPlannerPath {
  path: string
  revision: string
  exists: boolean
  content?: string
}

/** 现有文本文件的完整正文与磁盘编码；无 BOM 的 UTF-8 报告为 utf8。 */
export interface ProjectPlannerText extends ProjectPlannerPath {
  content: string
  textEncoding: ProjectTextEncoding
}

export interface ProjectPlannerResolver {
  resolveFileRef(fileRef: string): Promise<ProjectEditView>
  readPath(path: string): Promise<ProjectPlannerPath>
  /** 文件缺失、二进制、脱敏或超出完整读取上限时抛出 ProjectError。 */
  readText(path: string): Promise<ProjectPlannerText>
}
