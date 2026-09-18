/** SQLite 行的公共处理：JSON 字段容错解析、FTS 查询清洗、标签文本拼接。 */

import { isBlank, Log } from '@velaros-ai/core'

const log = Log.tag('KnowledgeRows')

/** 安全解析 JSON 字段，坏数据时退回给定的兜底值。 */
export function parseJsonField<T>(raw: string, fallback: T): T {
  if (isBlank(raw)) return fallback

  try {
    return JSON.parse(raw) as T
  } catch (error) {
    log.debug('解析 knowledge JSON 字段失败，使用 fallback', {
      error: String(error),
    })
    return fallback
  }
}

/** 把 tags 数组拼成 FTS 可索引的一行文本。 */
export function buildSearchTagsText(tags: string[]): string {
  return tags
    .map((tag) => tag.trim())
    .filter((tag) => !isBlank(tag))
    .join(' ')
}

/** 把用户查询转成安全的 SQLite FTS MATCH 表达式：逐词加引号再用 OR 连接。 */
export function sanitizeFtsQuery(query: string): string {
  const normalized = query.replace(/[^\p{L}\p{N}\s/_-]/gu, ' ').trim()

  if (isBlank(normalized)) return ''

  return (
    normalized
      .split(/\s+/)
      .filter((term) => !isBlank(term))
      // 每个词单独加引号并用 OR 连接，避免特殊字符影响 FTS 语法。
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(' OR ')
  )
}
