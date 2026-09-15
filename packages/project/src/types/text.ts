/** 按换行符适配后的文本匹配：文件是 CRLF 而片段只含 LF 时，matchedText 与 replacementText 已换成 CRLF。 */
export interface LineEndingAwareTextMatch {
  /** 第一处匹配的下标；没有匹配时是 -1。 */
  index: number
  /** 匹配总数。 */
  count: number
  /** 实际拿去匹配的片段。 */
  matchedText: string
  /** 换行符跟着 matchedText 适配后的替换文本。 */
  replacementText?: string
}

/** Project 支持无损读取与重建的磁盘文本编码。 */
export type ProjectTextEncoding =
  'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'utf16le-nobom' | 'utf16be-nobom' | 'gb18030'

/**
 * 流式编码判定的进度：还没被淘汰的候选解码器、留下的文件头、读没读到过 NUL 字节。一次判定一份，
 * 由 utils/text.ts 的探测函数建立、喂字节、收尾；文件头只留有限的前缀，内存不随文件增长。
 */
export interface ProjectTextEncodingProbe {
  /** 还能无损解码已读字节的候选，键是 TextDecoder 的编码标签。 */
  readonly decoders: Map<string, TextDecoder>
  /** 文件头缓冲，BOM 与无 BOM UTF-16 的判定只看它。 */
  readonly head: Uint8Array
  /** 文件头缓冲里已经填了多少字节。 */
  headLength: number
  /** 读过的字节里有没有 NUL。 */
  hasNul: boolean
}
