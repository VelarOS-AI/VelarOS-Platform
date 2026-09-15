import type * as ts from 'typescript'

import type { ProjectTextEncoding } from './text.js'

export type TextMismatchCause =
  | 'line_ending'
  | 'trailing_whitespace'
  | 'indentation'
  | 'backslash_escape'
  | 'quote_style'
  | 'content'
  | 'end_of_file'
  | 'absent'

export interface TextMatchMissDiagnosis {
  /** oldText 在文件中最接近的对齐起始行（1-based）；连相近的行都找不到时缺省。 */
  candidateLine?: number
  /** 候选位置从 oldText 第 1 行起、忽略行尾空白与换行符后连续一致的行数。 */
  matchedLines?: number
  oldTextLines: number
  firstMismatch?: {
    oldTextLine: number
    fileLine: number
    expected: string
    /** null 表示文件在该行之前已结束。 */
    actual: Nullable<string>
  }
  causes: TextMismatchCause[]
  /** 首个分歧之前各行存在、但宽容匹配会自动忽略的差异（行尾空白、换行符），无需修正。 */
  tolerated?: TextMismatchCause[]
  hint: string
}

export interface TextMatchLocation {
  occurrence: number
  line: number
  /** 匹配所在行之上最近的外层（缩进更浅的）行，用来区分同形文本分别属于哪个块。 */
  within?: string
}

export interface CandidateStart {
  start: number
  /** 产生该起点的锚的相似度；精确对齐的锚为 1。 */
  similarity: number
}

export interface ProjectRelocatedEdit {
  editIndex: number
  range: number | [number, number]
  unchanged: true
}

export interface SourceLine {
  start: number
  bodyEnd: number
  end: number
  logicalStart: number
  newline: string
}

export interface OffsetWindow { start: number; end: number }

export interface ProjectResolvedMutation {
  start: number
  end: number
  text: string
  editIndex: number
  fileIndex?: number
  /** 文件末尾空行的替换仍按替换操作检查重叠。 */
  kind: 'replace' | 'insert'
}

export interface PlannerCoverageWindow { start: number; end: number }

export interface ProjectMatchCandidate {
  range: readonly [number, number]
  startOffset: number
  endOffset: number
  text: string
  truncated: boolean
  match?: string
  prefix?: string
  suffix?: string
  differences?: readonly string[]
  confidence: 'exact' | 'whitespace' | 'similar'
}

/** match 在所选区域之外的一处原文（首尾行）：visible 表示它在 fileRef 可见范围内，只是不在 range 里。 */
export interface ProjectMatchElsewhere { range: readonly [number, number]; visible: boolean }

/** 用 text 替换原文的 [start, end)。 */
export interface SourceSplice {
  start: number
  end: number
  text: string
}

/** named 列表里的一项：`a`、`a as b`、`type a`；imported/local 用于判重，text 原样写回源码。 */
export interface NamedSpec {
  imported: string
  local: string
  typeOnly: boolean
  text: string
}

export interface ImportStyle {
  quote: string
  semicolon: string
}

export type ImportBinding =
  | { kind: 'default'; clause: ts.ImportClause }
  | { kind: 'namespace'; clause: ts.ImportClause }
  | { kind: 'named'; clause: ts.ImportClause; element: ts.ImportSpecifier }

export interface FileIdentity {
  view: ProjectEditView
  initial: ProjectEditView
  created: boolean
  deleted: boolean
  generation: number
  history: Array<{ content: string; mutations?: readonly ProjectResolvedMutation[] }>
}

export interface SourceSelection { identity: FileIdentity; view: ProjectEditView }

/** 回执只报告模型可读的格式名；转换本身由事务字节计划按目标编码重写。 */
export interface ProjectRecodeReceipt {
  converted: Array<{ path: string; from: string; to: string }>
  unchanged: string[]
}

/** 行号或连续闭区间；坐标总是指向 resolver 提供的那份不可变原文。 */
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

/** sourceRef 跟随文件身份穿过此前的计划步骤；path 只指本计划新建的文件。 */
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

/** readPath 观察目标路径存不存在，路径不存在时也返回一个 revision。 */
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
