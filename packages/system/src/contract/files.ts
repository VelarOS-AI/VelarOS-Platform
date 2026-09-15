/**
 * 文件数据：读与写的输入与结果、文本文件的编码与内容、搜索可见性的判定输入、gitignore 规则。
 * 只放数据；带行为的接口在 `interface/`。
 */

import type { ToolResultModelContentPart } from '@velaros-ai/agent/protocol'

// ── 读与写的输入与结果 ────────────────────────────────────────

/** 文件里的一段字符范围：从 offset 起到 end 止，end 不含。read 返回它，edit 收它。 */
export interface SystemTextRange {
  offset: number
  end: number
}

/** 读文本文件的入参：从第几个字符起、最多多少字符，都可省；给 version 就读改动前留下的那个版本。 */
export interface SystemReadInput {
  path: string
  offset?: number
  maxChars?: number
  version?: string
}

/** 读文本文件的结果：content 是 range 这段的原文，hasMore 时把 range.end 当下一次的 offset 接着读；version 是这份内容的版本号。 */
export interface SystemReadResult {
  path: string
  version: string
  content: string
  range: SystemTextRange
  totalChars: number
  hasMore: boolean
  encoding: SystemTextEncoding
}

/** 看图片或 PDF 的入参：PDF 一次一页，page 从 1 起，不给就是第 1 页。 */
export interface SystemViewInput {
  path: string
  page?: number
}

/** 看图片的结果：整张图作为模型可见的内容块交给模型，效果和用户上传一样。 */
export interface SystemViewImageResult {
  path: string
  kind: 'image'
  mediaType: string
  bytes: number
  modelContent: ToolResultModelContentPart[]
}

/** 看 PDF 的结果：只有 page 这一页作为文档内容块交给模型，pageCount 告诉调用方一共几页。 */
export interface SystemViewDocumentResult {
  path: string
  kind: 'document'
  mediaType: string
  page: number
  pageCount: number
  bytes: number
  modelContent: ToolResultModelContentPart[]
}

export type SystemViewResult = SystemViewImageResult | SystemViewDocumentResult

/** 文件改动前留下的一个版本：版本号是内容的哈希，buffer 是当时的原始字节。 */
export interface SystemFileSnapshot {
  version: string
  buffer: Buffer
  savedAt: number
}

/** 读文件时认出的媒体类型。 */
export interface SystemMediaType {
  kind: 'image' | 'document'
  mediaType: string
}

/** 按字符取出的一段文本，以及它实际落在的范围。 */
export interface SystemTextSlice {
  content: string
  range: SystemTextRange
}

/**
 * 写文件的入参，四种组合覆盖全部改法：
 * 只给 newText：把它当整个文件写进去；加 range：把 read 读到的这段整个换成 newText；
 * 再加 oldText：只在这段里找 oldText 换掉，匹配只在 read 读到的范围里做，没有 range 就不做匹配；
 * 只给 restore：回到改动前留下的那个版本。
 * oldText 在范围里匹配到多处时不改文件，返回每处的锚点，把选中锚点的 range 传回来就是二次确认。
 */
export interface SystemEditInput {
  path: string
  newText?: string
  oldText?: string
  range?: SystemTextRange
  restore?: string
}

/** 整个文件写入的结果：version 是写完后的版本号，previousVersion 是改动前留下的版本，新建或没留下时为 null。 */
export interface SystemEditWrittenResult {
  path: string
  action: 'written'
  created: boolean
  version: string
  previousVersion: Nullable<string>
  bytes: number
  totalChars: number
}

/** 替换的结果：content 是改动后那一段的新内容，不用再读一遍确认；range 是它在新文件里的位置。 */
export interface SystemEditReplacedResult {
  path: string
  action: 'replaced'
  version: string
  previousVersion: Nullable<string>
  bytes: number
  totalChars: number
  content: string
  range: SystemTextRange
  hasMore: boolean
}

/** 回滚的结果：文件回到 version 那个版本，回滚前的内容留成 previousVersion，回滚本身也能再回滚。 */
export interface SystemEditRestoredResult {
  path: string
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

/** oldText 匹配到多处时的结果：文件没动，anchors 列出每处（最多 20 个），matchCount 是总数；选一个把它的 range 传回来确认。 */
export interface SystemEditAmbiguousResult {
  path: string
  action: 'ambiguous'
  anchors: SystemEditAnchor[]
  matchCount: number
  totalChars: number
}

export type SystemEditResult = SystemEditWrittenResult | SystemEditReplacedResult | SystemEditRestoredResult | SystemEditAmbiguousResult

// ── 文本文件的编码与内容 ────────────────────────────────────────

export type SystemTextEncoding =
  | 'utf8'
  | 'utf8-bom'
  | 'utf16le'
  | 'utf16be'
  | 'utf16le-nobom'
  | 'utf16be-nobom'

export interface SystemTextFileContent {
  buffer: Buffer
  content: string
  encoding: SystemTextEncoding
}

// ── 搜索可见性 ──────────────────────────────────────────────────

export interface SystemSearchIgnorePolicyOptions {
  unrestricted?: boolean
}

export interface SystemSearchProtectedDirectoryInput {
  platform: string
  homeDir: string
  rootPath: string
  candidatePath: string
}

// ── gitignore 规则 ────────────────────────────────────

/** 一条解析后的 gitignore 规则：相对哪个目录生效、是否取反、是否只匹配目录、是否锚定、按 `/` 切开的模式片段。 */
export interface GitIgnoreRule {
  baseRelativePath: string
  negative: boolean
  directoryOnly: boolean
  anchored: boolean
  segments: string[]
}
