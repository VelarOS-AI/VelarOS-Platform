import type * as ts from 'typescript'

import type { TextEncoding } from '@velaros-ai/core/text-files/contracts'

import type { EditIntent } from './edit.js'
import type { ProjectVisibleCoverage } from './file-refs.js'
import type {
  ProjectRecodeEncoding,
  ProjectRecodeNewline,
  ProjectRecodeReceipt,
  ProjectStepSource,
} from './files.js'

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
  /** 候选区域的有界原文；仅供核对，不能证明这是用户要改的位置。 */
  candidateText?: { text: string; truncated: boolean }
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

/**
 * 一份源码的坐标索引：物理行表与把 CRLF 换成 LF 的逻辑正文，CRLF 算一个逻辑换行，其余字符都按原样计。
 * 建好就不再变，由 utils/editing/source.ts 建立和查询；物理偏移是原文里的下标，逻辑偏移是逻辑正文里的下标。
 */
export interface ProjectSourceCoordinates {
  /** 原文。 */
  readonly content: string
  /** 物理行表；末尾换行之后的空行也算一行。 */
  readonly lines: readonly SourceLine[]
  /** 把 CRLF 换成 LF 之后的逻辑正文。 */
  readonly logical: string
}

export interface OffsetWindow {
  start: number
  end: number
}

export interface ProjectResolvedMutation {
  start: number
  end: number
  text: string
  editIndex: number
  fileIndex?: number
  /** 文件末尾空行的替换仍按替换操作检查重叠。 */
  kind: 'replace' | 'insert'
}

export interface PlannerCoverageWindow {
  start: number
  end: number
}

export interface ProjectMatchCandidate {
  range: readonly [number, number]
  text: string
  truncated: boolean
  match?: string
  prefix?: string
  suffix?: string
  differences?: readonly string[]
  confidence: 'exact' | 'whitespace' | 'similar'
}

/** match 在所选区域之外的一处原文（首尾行）：visible 表示它在 fileRef 可见范围内，只是不在 range 里。 */
export interface ProjectMatchElsewhere {
  range: readonly [number, number]
  visible: boolean
}

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

export interface SourceSelection {
  identity: FileIdentity
  view: ProjectEditView
}

/**
 * `velaros:project` 的 edit 编译到一半的计划：每个路径在计划里的未来身份、引用绑定到的身份，以及已经排好的事务操作。
 * 只在一次编译里用，由 utils/editing/file-planner.ts 的函数推进；不读写磁盘，读取都经过 resolver。
 */
export interface ProjectFilePlanState {
  /** 读当前文件视图、目标路径与完整正文的端口。 */
  readonly resolver: ProjectPlannerResolver
  /** 路径在计划里的文件身份；null 表示这个路径已在本计划里删除或移走。 */
  readonly paths: Map<string, Nullable<FileIdentity>>
  /** fileRef、sourceRef 绑定到的文件身份与它当前的视图。 */
  readonly references: Map<string, SourceSelection>
  /** 排好的事务操作，顺序就是执行顺序。 */
  readonly operations: EditIntent[]
  /** 每个涉及的路径在计划开始时的磁盘 revision。 */
  readonly baseRevisions: Record<string, string>
  /** recode 动作的回执。 */
  readonly recode: ProjectRecodeReceipt
}

export interface ProjectEditView {
  path: string
  revision: string
  content: string
  coverage: readonly ProjectVisibleCoverage[]
}

/** 批量改写磁盘编码、BOM 与物理换行；Unicode 正文不变，按路径而非 fileRef 指定。 */
export interface ProjectRecodeAction {
  op: 'recode'
  paths: readonly string[]
  encoding?: ProjectRecodeEncoding
  bom?: boolean
  newline?: ProjectRecodeNewline
}

/** 规划器内部的文件动作：模型的步骤按 op 改写，sourceRef 跟随文件身份穿过此前的步骤，path 只指本计划新建的文件。 */
export type ProjectPlanFileAction =
  | { op: 'create'; path: string; text: string }
  | ({ op: 'overwrite'; text: string } & ProjectStepSource)
  | ({ op: 'move'; to: string } & ProjectStepSource)
  | ({ op: 'delete' } & ProjectStepSource)
  | ProjectRecodeAction

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
  textEncoding: TextEncoding
}

export interface ProjectPlannerResolver {
  resolveFileRef(fileRef: string): Promise<ProjectEditView>
  readPath(path: string): Promise<ProjectPlannerPath>
  /** 文件缺失、二进制或超出完整读取上限时抛出 ProjectError。 */
  readText(path: string): Promise<ProjectPlannerText>
  /** 按 glob 列出项目里匹配的文件（相对项目根，遵守 .gitignore）：recode 的 paths 写成 glob 时用它展开。 */
  listPaths(pattern: string): Promise<string[]>
}
