/**
 * 文件数据：读、看、写的输入与结果（文本编码用公共件 text-files 的 `TextEncoding`），以及文件操作与搜索实现自己的工作类型（文本内容与切片、媒体类型、版本快照、gitignore 规则、敏感路径判定的环境、写入计划与印记）。
 * 只放类型；后一部分只在包内用，公开签名不引用它们，所以不出包。
 */

import type { ToolResultModelContentPart } from '@velaros-ai/agent/contracts'
import type { DecodedText, TextEncoding } from '@velaros-ai/text-files/contracts'

/** @AgentView 文件里的一段字符范围，end 不含。read 返回它，edit 原样收回去。 */
export interface SystemTextRange {
  offset: number
  end: number
}

/** @AgentView 给 version 就读改动前留下的那个版本；只有本次运行里 edit 留下的几份还在，找不到算这个文件失败。 */
export interface SystemReadFileInput {
  path: string
  offset?: number
  maxChars?: number
  version?: string
}

/** @AgentView 一批最多 20 项；一次调用总共最多返回 20 万字符，按顺序分给各文件。 */
export type SystemReadInput = {
  files: SystemReadFileInput[]
}

/** @AgentView content 是 range 这段的原文；hasMore 时把 range.end 当下一次的 offset 接着读。version 是这份内容的版本号，read 与 edit 都收它。 */
export interface SystemReadFileResult {
  path: string
  version: string
  content: string
  range: SystemTextRange
  totalChars: number
  hasMore: boolean
  encoding: TextEncoding
}

/** @AgentView 一批里某个文件读不了或看不了：只有它这一项是失败，其余文件照常返回；全部失败时整个调用才报错。path 照传入的原样。 */
export interface SystemFileFailure {
  path: string
  error: {
    code: string
    message: string
  }
}

/** @AgentView files 与入参的 files 一一对应。字符预算用完之后的文件根本没读，那一项是失败条目；note 说明哪个文件被截短、从第几个起没读。 */
export interface SystemReadResult {
  files: Array<SystemReadFileResult | SystemFileFailure>
  note?: string
}

/** @AgentView 一张图片。 */
export interface SystemViewFileInput {
  path: string
}

/** @AgentView 一批最多 10 张。 */
export type SystemViewInput = {
  files: SystemViewFileInput[]
}

/** @AgentView 看到的一张图片的元数据。 */
export interface SystemViewFileResult {
  path: string
  mediaType: string
  bytes: number
}

/** @AgentView files 与入参的 files 一一对应；modelContent 按同样的顺序放每张图，每块前面一行文字说明是哪个文件，失败的文件没有内容块。 */
export interface SystemViewResult {
  files: Array<SystemViewFileResult | SystemFileFailure>
  modelContent: ToolResultModelContentPart[]
}

/** @AgentView 只在 range 这段里改，不在整个文件里找：给 oldText 就只换这段里唯一的那一处，不给就把整段换成 newText，range 是空段就是在那个位置插入。 */
export interface SystemTextEdit {
  range: SystemTextRange
  oldText?: string
  newText: string
}

/**
 * @AgentView
 * 三种改法只用一种：newText 当整个文件写进去，不存在就连同上级目录新建，已有的二进制文件拒改；
 * edits 在 read 读到的范围里改几处，一次最多 50 处、各处不能重叠；restore 回到改动前留下的那个版本。
 * version 是 read 返回的版本号，给了就先核对文件现在还是这个版本，被改过就整批不写并给出当前版本；不给就不核对。
 */
export interface SystemEditFileInput {
  path: string
  newText?: string
  edits?: SystemTextEdit[]
  restore?: string
  version?: string
}

/** @AgentView 一批最多 20 项，全成或全不成。 */
export type SystemEditInput = {
  files: SystemEditFileInput[]
}

/** @AgentView previousVersion 是改动前留下的版本，新建或没留下时为 null；path 是解析后的绝对路径，它是符号链接时 target 是真正被写的那个文件。 */
export interface SystemEditWrittenResult {
  path: string
  target?: string
  action: 'written'
  created: boolean
  version: string
  previousVersion: Nullable<string>
  bytes: number
  totalChars: number
}

/** @AgentView edit 是 edits 里第几处；content 是新文本前后各带 200 字符，range 是这段在新文件里的位置。 */
export interface SystemEditWindow {
  edit: number
  range: SystemTextRange
  content: string
}

/** @AgentView windows 每处给一段新文本前后各 200 字符；盖住所有改动那段（各处 range 的并集）不超过 2 万字符时，content 和 range 把整段给出，不用再读一遍确认。 */
export interface SystemEditReplacedResult {
  path: string
  target?: string
  action: 'replaced'
  edits: number
  version: string
  previousVersion: Nullable<string>
  bytes: number
  totalChars: number
  windows: SystemEditWindow[]
  content?: string
  range?: SystemTextRange
}

/** @AgentView 文件回到 version 那个版本；回滚前的内容留成 previousVersion，回滚本身也能再回滚。 */
export interface SystemEditRestoredResult {
  path: string
  target?: string
  action: 'restored'
  version: string
  previousVersion: Nullable<string>
  bytes: number
  totalChars: number
}

/** 一处候选：range 是它在文件里的位置，context 是前后各带一小段的原文，用来分辨是哪一处。 */
export interface SystemEditAnchor {
  range: SystemTextRange
  context: string
}

/** 一处定不下来的问题：file 是 files 里第几个（从 0 起），edit 是它 edits 里第几处（从 0 起，整个文件的问题没有）；多处匹配时 anchors 列出前 10 处、matchCount 是找到几处（超过 10 处只数到 11 为止），选一个把它的 range 填回那一处；重叠时 with 是和它重叠的那一处；文件被改过时 currentVersion 是它现在的版本。 */
export interface SystemEditProblem {
  file: number
  path: string
  reason: 'ambiguous' | 'not-found' | 'overlap' | 'invalid' | 'denied' | 'stale'
  message: string
  edit?: number
  anchors?: SystemEditAnchor[]
  matchCount?: number
  with?: number
  currentVersion?: string
}

/** edit 失败回执的 details：什么都没写（executionOutcome 固定是 not-applied，所以入参可以复用），problems 列出每个问题；用 reuse + changes 只改出问题的那一处再发。 */
export interface SystemEditFailureDetails {
  executionOutcome: 'not-applied'
  problems: SystemEditProblem[]
}

/** @AgentView 一个文件写完的结果，按 action 分辨是哪一种。 */
export type SystemEditFileResult = SystemEditWrittenResult | SystemEditReplacedResult | SystemEditRestoredResult

/**
 * @AgentView
 * files 与入参的 files 一一对应。
 * 任何一处定不下来就整个报错、一个文件都不写，错误的 cause.details.problems 逐条给出是第几个文件第几处、为什么；
 * 某处 oldText 在范围里匹配到多处时带出每处的锚点，把选中那处的 range 填回去再发一次就是二次确认。
 */
export interface SystemEditResult {
  files: SystemEditFileResult[]
}

// ── 实现自己的工作类型，不出包 ─────────────────────────────────────

/** 文件改动前留下的一个版本：版本号是内容的哈希，buffer 是当时的原始字节。 */
export interface SystemFileSnapshot {
  version: string
  buffer: Buffer
  savedAt: number
}

/** 读文件时认出的媒体类型：模型认得的图片，或 PDF 这类文档（本包不看，只用来把错误说清楚）。 */
export interface SystemMediaType {
  kind: 'image' | 'document'
  mediaType: string
}

/** 按字符取出的一段文本，以及它实际落在的范围。 */
export interface SystemTextSlice {
  content: string
  range: SystemTextRange
}

/** 读进来的一个文本文件：原始字节，以及按认出的编码严格解出的正文。 */
export interface SystemTextFileContent extends DecodedText {
  buffer: Buffer
}

export interface SystemSearchProtectedDirectoryInput {
  platform: string
  homeDir: string
  rootPath: string
  candidatePath: string
}

/** 判断敏感路径、凭证文件时的环境：平台、家目录、临时目录、环境变量，缺省取当前进程的。临时目录不触发敏感路径审批；Windows 与 macOS 的路径按大小写不敏感比较。 */
export interface SensitiveSystemMutationPathOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  tempDir?: string
  env?: NodeJS.ProcessEnv
}

/** 一处已经定下来的目标：edit 是 edits 里第几处，range 是改动前原文里的位置。 */
export interface SystemEditTarget {
  edit: number
  range: SystemTextRange
  newText: string
}

/** 文件的印记：修改时间与大小。写之前再 stat 一次，印记没变的大文件不用重读核版本。 */
export interface SystemFileStamp {
  mtimeMs: number
  size: number
}

/**
 * 一个文件定下来的写入计划：回滚、整个写入、或改几处。path 是按传入路径解析出的绝对路径，target 是解开符号链接后真正要写的文件，
 * baseVersion 与 stamp 是计划时文件的版本和印记（不存在为 null），写之前再核一次。要写的字节在计划时就按原编码编好（bytes），编不成的在计划期就成了问题：
 * 回滚带回滚后正文的字符数，整个写入时 previous 只在文件不超过可编辑上限时保留（留版本用），改几处时 updated 是改完的正文。第一段只做计划，第二段照计划写。
 */
export type SystemEditPlan =
  | { kind: 'restore'; index: number; path: string; target: string; current: Nullable<Buffer>; snapshot: { version: string; buffer: Buffer }; totalChars: number; baseVersion: Nullable<string>; stamp: Nullable<SystemFileStamp> }
  | { kind: 'write'; index: number; path: string; target: string; created: boolean; previous: Nullable<{ buffer: Buffer }>; newText: string; bytes: Buffer; baseVersion: Nullable<string>; stamp: Nullable<SystemFileStamp> }
  | { kind: 'edits'; index: number; path: string; target: string; textFile: SystemTextFileContent; ordered: SystemEditTarget[]; scopes: SystemTextRange[]; updated: string; bytes: Buffer; baseVersion: Nullable<string>; stamp: Nullable<SystemFileStamp> }
