/**
 * 文件数据：读、看、写的输入与结果、文本编码，以及文件操作与搜索实现自己的工作类型（文本内容与切片、媒体类型、版本快照、gitignore 规则、敏感路径判定的环境、写入计划与印记）。
 * 只放类型；后一部分只在包内用，公开签名不引用它们，所以不出包。
 */

import type { ToolResultModelContentPart } from '@velaros-ai/agent/protocol'

/** 文件里的一段字符范围：从 offset 起到 end 止，end 不含。read 返回它，edit 收它。 */
export interface SystemTextRange {
  offset: number
  end: number
}

/** 读一个文本文件：从第几个字符起、最多多少字符，都可省；给 version 就读改动前留下的那个版本（只有本次运行里 edit 留下的版本在）。 */
export interface SystemReadFileInput {
  path: string
  offset?: number
  maxChars?: number
  version?: string
}

/** 读文本文件的入参：files 里每项一个文件，一个文件就一项，一批就多项；一次调用总共最多返回 20 万字符。 */
export type SystemReadInput = {
  files: SystemReadFileInput[]
}

/** 一个文件读到的内容：content 是 range 这段的原文，hasMore 时把 range.end 当下一次的 offset 接着读；version 是这份内容的版本号。 */
export interface SystemReadFileResult {
  path: string
  version: string
  content: string
  range: SystemTextRange
  totalChars: number
  hasMore: boolean
  encoding: SystemTextEncoding
}

/** 一批里某个文件读不了或看不了：只有它自己失败，其余文件照常返回；全部失败时整个调用报错。path 照传入的原样。 */
export interface SystemFileFailure {
  path: string
  error: {
    code: string
    message: string
  }
}

/** 读文本文件的结果：files 与入参的 files 一一对应，每项是读到的内容或这个文件的失败；一次调用的字符预算不够时，被截短的文件 hasMore 为真，预算用完后的文件不读盘、那一项换成失败条目，note 说明从第几个文件起。 */
export interface SystemReadResult {
  files: Array<SystemReadFileResult | SystemFileFailure>
  note?: string
}

/** 看一张图片。 */
export interface SystemViewFileInput {
  path: string
}

/** 看图片的入参：files 每项一个文件，一个文件就一项，一批就多项。 */
export type SystemViewInput = {
  files: SystemViewFileInput[]
}

/** 看到的一张图片的元数据。 */
export interface SystemViewFileResult {
  path: string
  mediaType: string
  bytes: number
}

/** 看图片的结果：files 与入参的 files 一一对应；modelContent 按同样的顺序放每张图的内容块（整张交给模型，效果和用户上传一样），每块前面一行文字说明是哪个文件，失败的文件没有内容块。 */
export interface SystemViewResult {
  files: Array<SystemViewFileResult | SystemFileFailure>
  modelContent: ToolResultModelContentPart[]
}

/** 一处改动：在 range 这段里改；给 oldText 就只换这段里唯一的那一处，不给就把整段换成 newText，range 是空段就是在那个位置插入。 */
export interface SystemTextEdit {
  range: SystemTextRange
  oldText?: string
  newText: string
}

/**
 * 改一个文件，三种改法各自一项、只用一种：
 * 只给 newText：把它当整个文件写进去，不存在就新建；给 edits：在 read 读到的范围里改这几处，各处不能重叠；只给 restore：回到改动前留下的那个版本。
 * 一批里所有文件所有改动先一起定下来再一起写，全成或全不成；某处的 oldText 在范围里匹配到多处时整批不写，失败回执里给出是第几处和每处的锚点，把选中锚点的 range 填回那一处就是二次确认。
 * version 是 read 返回的版本号，给了就先核对文件现在还是这个版本，被改过就整批不写并给出当前版本；不给就不核对。
 */
export interface SystemEditFileInput {
  path: string
  newText?: string
  edits?: SystemTextEdit[]
  restore?: string
  version?: string
}

/** 写文件的入参：files 每项一个文件，一个文件就一项，一批就多项，各自带各自的改法；一批全成或全不成。 */
export type SystemEditInput = {
  files: SystemEditFileInput[]
}

/** 整个文件写入的结果：version 是写完后的版本号，previousVersion 是改动前留下的版本，新建或没留下时为 null；path 是按传入路径解析出的绝对路径，它是符号链接时 target 是真正被写的那个文件。 */
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

/** 一处改动改完后的样子：edit 是 edits 里第几处，content 是新文本前后各带 200 字符的原文，range 是这段在新文件里的位置。 */
export interface SystemEditWindow {
  edit: number
  range: SystemTextRange
  content: string
}

/** 改了几处的结果：edits 是改了几处，windows 每处一段新文本前后各 200 字符；盖住所有改动那段（各处 range 的并集）不超过 2 万字符时，content 和 range 整段给出，不用再读一遍确认；超过就只有 windows。 */
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

/** 回滚的结果：文件回到 version 那个版本，回滚前的内容留成 previousVersion，回滚本身也能再回滚。 */
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

/** 一个文件写完的结果。 */
export type SystemEditFileResult = SystemEditWrittenResult | SystemEditReplacedResult | SystemEditRestoredResult

/** 写文件的结果：files 与入参的 files 一一对应。一批全成或全不成：任何一处定不下来整个调用报错、什么都不写，问题列在失败回执的 details.problems 里。 */
export interface SystemEditResult {
  files: SystemEditFileResult[]
}

export type SystemTextEncoding =
  | 'utf8'
  | 'utf8-bom'
  | 'utf16le'
  | 'utf16be'
  | 'utf16le-nobom'
  | 'utf16be-nobom'

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

export interface SystemTextFileContent {
  buffer: Buffer
  content: string
  encoding: SystemTextEncoding
}

export interface SystemSearchIgnorePolicyOptions {
  unrestricted?: boolean
}

export interface SystemSearchProtectedDirectoryInput {
  platform: string
  homeDir: string
  rootPath: string
  candidatePath: string
}

/** 一条解析后的 gitignore 规则：相对哪个目录生效、是否取反、是否只匹配目录、是否锚定、按 `/` 切开的模式片段。 */
export interface GitIgnoreRule {
  baseRelativePath: string
  negative: boolean
  directoryOnly: boolean
  anchored: boolean
  segments: string[]
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
 * baseVersion 与 stamp 是计划时文件的版本和印记（不存在为 null），写之前再核一次。整个写入时 previous 只在文件不超过可编辑上限时保留（留版本用），encoding 是写回用的编码。第一段只做计划，第二段照计划写。
 */
export type SystemEditPlan =
  | { kind: 'restore'; index: number; path: string; target: string; current: Nullable<Buffer>; snapshot: { version: string; buffer: Buffer }; baseVersion: Nullable<string>; stamp: Nullable<SystemFileStamp> }
  | { kind: 'write'; index: number; path: string; target: string; created: boolean; previous: Nullable<{ buffer: Buffer; encoding: SystemTextEncoding }>; encoding: SystemTextEncoding; newText: string; baseVersion: Nullable<string>; stamp: Nullable<SystemFileStamp> }
  | { kind: 'edits'; index: number; path: string; target: string; textFile: { buffer: Buffer; content: string; encoding: SystemTextEncoding }; ordered: SystemEditTarget[]; scopes: SystemTextRange[]; baseVersion: Nullable<string>; stamp: Nullable<SystemFileStamp> }
