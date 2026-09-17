/**
 * 文本数据：`read` 的结果（带文本编码，所以不在可移植文件里），以及读和看的实现自己的工作类型（媒体类型、读进来的文本、看过的一张图）。
 * 只放类型；后一部分只在包内用，公开签名不引用它们，所以不出包。
 */

import type { DecodedText, TextEncoding } from '@velaros-ai/text-files/contracts'

import type { FileFailure, FileImageRegion, FileImageResult } from './files.js'

/**
 * @AgentView
 * content 是整个文件的原文，换行风格原样保留。它**落在程序的变量里，不进你的上下文**——
 * 要看哪一段就 export default 哪一段；不知道文件多大，先看 `content.length` 再决定。
 * version 是这份内容的版本号，回写时带上它就能挡住「读完之后别人又改过」。
 */
export interface FileTextResult {
  path: string
  version: string
  content: string
  encoding: TextEncoding
}

/** @AgentView files 与入参的 files 一一对应；某个文件读不了只有它那一项是失败。 */
export interface FileReadResult {
  files: Array<FileTextResult | FileFailure>
}

// ── 实现自己的工作类型，不出包 ─────────────────────────────────────

/** 读文件时认出的媒体类型：模型认得的图片，或 PDF 这类文档（本包不看，只用来把错误说清楚）。 */
export interface FileMediaType {
  kind: 'image' | 'document'
  mediaType: string
}

/** 读进来的一个文本文件：原始字节，以及按认出的编码严格解出的正文。 */
export interface FileTextContent extends DecodedText {
  buffer: Buffer
}

/** 看一张图的结果：给模型看的条目、要交出去的字节，以及要了哪一块。 */
export interface FileViewed {
  entry: FileImageResult
  image: { data: Buffer; mediaType: string }
  region: Nullable<FileImageRegion>
}
