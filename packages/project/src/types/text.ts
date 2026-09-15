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
