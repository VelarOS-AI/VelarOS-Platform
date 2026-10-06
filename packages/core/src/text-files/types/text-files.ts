/**
 * 可移植数据：编码名、解码结果、写前要核对的原字节、流式读出的一块正文。
 * 只从常量表 import type，不带函数，浏览器和渲染进程都能用；从 `@velaros-ai/core/text-files/contracts` 取。
 */

import type { TextEncodings } from '../contract/constants.js'

/**  文件在磁盘上的文本编码。utf8-bom、utf16le、utf16be 带 BOM，-nobom 的不带；gb18030 也包括 GBK 与 GB2312 的文件。 */
export type TextEncoding = (typeof TextEncodings)[number]

/** 一段字节解码出的正文与认出的编码。 */
export interface DecodedText {
  /** 解码出的正文，不含 BOM。 */
  content: string
  /** 认出的磁盘编码，写回时按它编码。 */
  encoding: TextEncoding
}

/** 写前要核对的原字节：exists 为假表示文件应当不存在；为真时磁盘上的字节必须和 bytes 一模一样。 */
export interface ExpectedBytes {
  /** 文件应当存在（真）还是不存在（假）。 */
  readonly exists: boolean
  /** 文件应当有的全部字节；exists 为真时必须给，不给一律按对不上处理。 */
  readonly bytes?: Uint8Array
}

/** 流式读出的一块正文。 */
export interface TextChunk {
  /** 这一块解出的正文；被块边界切开的多字节字符留到下一块。 */
  content: string
  /** 到这一块为止读过的字节数，也就是这块末尾在文件里的字节位置。 */
  byteOffset: number
}
