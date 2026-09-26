/**
 * 文本数据：`read` 的结果（带文本编码，所以不在可移植文件里），以及读的实现自己的工作类型（媒体类型、读进来的文本）。
 * 只放类型；后一部分只在包内用，公开签名不引用它们，所以不出包。
 */

import type { DecodedText, TextEncoding } from '@velaros-ai/core/text-files/contracts'

import type { FileFailure } from './files.js'

/**
 * @AgentView
 * 读到的一个文件（或它的那几行）：text 是连续的正文，startLine 是它第一行的行号，totalLines 是整个文件的行数。
 * 换行一律是 `\n`（原文件是 CRLF 的也一样）；读到文件末尾时，文件结尾的换行照原样在 text 里——整份读出来原样 write 回去，不多一行也不少一行。
 * 行号的数法和 `wc -l` 一样：结尾那个换行不算多出一行，空文件是 0 行。
 * text 落在程序的变量里，**不进你的上下文**——要看哪一段就 export default 哪一段。
 */
export interface FileText {
  path: string
  target?: string
  encoding: TextEncoding
  totalLines: number
  startLine: number
  text: string
}

/** @AgentView files 与入参的 files 一一对应；某个文件读不了只有它那一项是失败。 */
export interface FileReadResult {
  files: Array<FileText | FileFailure>
}

// ── 实现自己的工作类型，不出包 ─────────────────────────────────────

/** 读文件时认出的媒体类型：图片或 PDF 这类文档（本包不看，只用来把错误说清楚）。 */
export interface FileMediaType {
  kind: 'image' | 'document'
  mediaType: string
}

/** 读进来的一个文本文件：原始字节，以及按认出的编码严格解出的正文。 */
export interface FileTextContent extends DecodedText {
  buffer: Buffer
}

/** 一份正文按物理行拆开：每行的正文与它自己的换行符（`\n`、`\r\n`，最后一行没有换行时是空串），以及新写的行用哪种换行。 */
export interface FileTextLines {
  lines: Array<{ text: string; br: string }>
  eol: '\n' | '\r\n'
}
