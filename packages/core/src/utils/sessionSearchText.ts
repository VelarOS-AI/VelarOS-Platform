/** 折叠空白并小写，用于整段文本比较（标题、本地过滤）。 */
function normalizeSessionSearchText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

/** 从查询提取长度至少为 2 的词项，用于高亮与粗排。 */
function extractSessionSearchTerms(query: string, maxTerms = 12): string[] {
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, maxTerms)
}

export { extractSessionSearchTerms, normalizeSessionSearchText }
