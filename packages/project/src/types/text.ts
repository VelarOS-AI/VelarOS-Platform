/** Project 支持无损读取与重建的磁盘文本编码。 */
export interface LineEndingAwareTextMatch {
  index: number
  count: number
  matchedText: string
  replacementText?: string
}

export type ProjectTextEncoding =
  'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'utf16le-nobom' | 'utf16be-nobom' | 'gb18030'
