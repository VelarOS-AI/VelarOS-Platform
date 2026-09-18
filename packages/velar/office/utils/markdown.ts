/** Markdown 原语：表格行解析、表格分隔行判定，以及返回给模型的 Markdown 截断。 */

/**
 * 解析单行 Markdown 表格，保留中间空单元格并去掉首尾管道。
 *
 * 单源判据（§3.7）：Word 与 Excel 两条生成路径曾各留一份**逐字相同**的拷贝。两份对"什么算表格行"
 * 的判定必须一致，否则同一段 Markdown 生成的 Word 表格与 Excel 表格会开始分叉。要改判定就改这里一处。
 */
export function parseMarkdownTableRow(line: string): Nullable<string[]> {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  let cells = trimmed.split('|')
  if (trimmed.startsWith('|')) cells = cells.slice(1)
  if (trimmed.endsWith('|')) cells = cells.slice(0, -1)
  const normalized = cells.map((cell) => cell.trim())
  return normalized.length >= 2 ? normalized : null
}

/** 判断 Markdown 表格分隔行，例如 | --- | :---: |。 */
export function isMarkdownTableSeparator(line: string): boolean {
  const row = parseMarkdownTableRow(line)
  return !!row?.length && row.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

/** 按 maxChars 截断返回给模型的 Markdown，并在末尾留一句说明。 */
export function truncateMarkdown(
  markdown: string,
  maxChars: number
): { markdown: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { markdown, truncated: false }

  return {
    markdown: `${markdown.slice(0, maxChars)}\n\n<!-- 后续内容已按 maxChars 截断 -->`,
    truncated: true,
  }
}
