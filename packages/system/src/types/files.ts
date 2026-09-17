/**
 * 文件数据：读、看、写的输入与结果（文本编码用公共件 text-files 的 `TextEncoding`），以及文件操作与搜索实现自己的工作类型（文本内容与切片、媒体类型、版本快照、gitignore 规则、敏感路径判定的环境、写入计划与印记）。
 * 只放类型；后一部分只在包内用，公开签名不引用它们，所以不出包。
 */

import type { ToolResultModelContentPart } from '@velaros-ai/agent/contracts'
import type { DecodedText, TextEncoding } from '@velaros-ai/text-files/contracts'

/** 文件里的一段字符范围，end 不含。只在包内用。 */
export interface SystemTextRange {
  offset: number
  end: number
}

/** @AgentView 整个文件读回来。给 version 就读改动前留下的那个版本；只有本次运行里 edit 留下的几份还在，找不到算这个文件失败。 */
export interface SystemReadFileInput {
  path: string
  version?: string
}

/** @AgentView 一批最多 20 项，每个文件整份读回来；总量超过上限时，超出的那几个各自算失败条目。 */
export type SystemReadInput = {
  files: SystemReadFileInput[]
}

/** @AgentView content 是整个文件的原文，换行风格原样保留。version 是这份内容的版本号，回写时带上它就能挡住「读完之后别人又改过」。 */
export interface SystemReadFileResult {
  path: string
  version: string
  content: string
  encoding: TextEncoding
}

/**
 * @AgentView
 * 一批里某个文件读不了或看不了：只有它这一项是失败，其余文件照常返回；全部失败时整个调用才报错。path 照传入的原样。
 * 它和成功那支**没有判别字段**，用 `'error' in file` 分开（`file.error` 在联合上取不到）。
 */
export interface SystemFileFailure {
  path: string
  error: {
    code: string
    message: string
  }
}

/** @AgentView files 与入参的 files 一一对应；某个文件读不了只有它那一项是失败。 */
export interface SystemReadResult {
  files: Array<SystemReadFileResult | SystemFileFailure>
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

/**
 * @AgentView
 * 两种改法只用一种：`newText` 当整个文件写进去（不存在就连同上级目录新建，已有的二进制文件拒改），
 * `restore` 回到改动前留下的那个版本。
 *
 * 改一小段也是给整份 `newText`——先 `read` 拿到 `content`，在程序里算出新内容再写回来。
 * **正文不经模型的上下文**，所以整份写和改一处一样便宜；`content.replace(...)` 比任何编辑协议都准。
 *
 * `version` 是 `read` 返回的版本号，给了就先核对文件现在还是这个版本，被改过就整批不写并给出当前版本；不给就不核对。
 * 想安全地改一个文件，就把 `read` 拿到的 `version` 原样带回来。
 */
export interface SystemEditFileInput {
  path: string
  newText?: string
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

/** 一处写不下去的问题：file 是 files 里第几个（从 0 起）；文件被改过时 currentVersion 是它现在的版本。 */
export interface SystemEditProblem {
  file: number
  path: string
  reason: 'invalid' | 'denied' | 'stale'
  message: string
  currentVersion?: string
}

/** edit 失败回执的 details：什么都没写（executionOutcome 固定是 not-applied），problems 列出每个问题。 */
export interface SystemEditFailureDetails {
  executionOutcome: 'not-applied'
  problems: SystemEditProblem[]
}

/** @AgentView 一个文件写完的结果，按 action 分辨是哪一种。 */
export type SystemEditFileResult = SystemEditWrittenResult | SystemEditRestoredResult

/**
 * @AgentView
 * files 与入参的 files 一一对应。任何一个写不下去就整个报错、一个文件都不写，
 * 错误的 cause.details.problems 逐条给出是第几个文件、为什么。
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

/** 文件的印记：修改时间与大小。写之前再 stat 一次，印记没变的大文件不用重读核版本。 */
export interface SystemFileStamp {
  mtimeMs: number
  size: number
}

/**
 * 一个文件定下来的写入计划：回滚，或整个写入。path 是按传入路径解析出的绝对路径，target 是解开符号链接后真正要写的文件，
 * baseVersion 与 stamp 是计划时文件的版本和印记（不存在为 null），写之前再核一次。要写的字节在计划时就按原编码编好（bytes），编不成的在计划期就成了问题：
 * 回滚带回滚后正文的字符数，整个写入时 previous 只在文件不超过可编辑上限时保留（留版本用）。第一段只做计划，第二段照计划写。
 */
export type SystemEditPlan =
  | { kind: 'restore'; index: number; path: string; target: string; current: Nullable<Buffer>; snapshot: { version: string; buffer: Buffer }; totalChars: number; baseVersion: Nullable<string>; stamp: Nullable<SystemFileStamp> }
  | { kind: 'write'; index: number; path: string; target: string; created: boolean; previous: Nullable<{ buffer: Buffer }>; newText: string; bytes: Buffer; baseVersion: Nullable<string>; stamp: Nullable<SystemFileStamp> }
