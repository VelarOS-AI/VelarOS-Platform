import { isArray, isNumber, isPlainObject, isString, isTrue } from '#internal/runtime'

export interface ProjectSourceView {
  path: string
  lines: Array<[number, string]>
  fragments: Array<{ line: number; columns: [number, number]; text: string }>
  hasMore: boolean
}

/** 统一解析读取、搜索、代码详情和编辑结果中的源码窗口。 */
export function collectProjectSourceViews(value: unknown): ProjectSourceView[] {
  const result: ProjectSourceView[] = []
  const visited = new WeakSet<object>()
  const visit = (item: unknown) => {
    if ((!isArray(item) && !isPlainObject(item)) || visited.has(item)) return
    visited.add(item)
    if (isArray(item)) { item.forEach(visit); return }
    const record = item
    if (record.kind === 'project-source-window' && isString(record.path)) {
      const lines = (isArray(record.lines) ? record.lines : []).filter((line): line is [number, string] => isArray(line) && line.length === 2 && isNumber(line[0]) && Number.isSafeInteger(line[0]) && line[0] > 0 && isString(line[1]))
      const fragments = (isArray(record.fragments) ? record.fragments : []).filter((fragment): fragment is ProjectSourceView['fragments'][number] => {
        if (!isPlainObject(fragment)) return false
        const part = fragment
        return Number.isSafeInteger(part.line) && isArray(part.columns) && part.columns.length === 2 && part.columns.every(Number.isSafeInteger) && isString(part.text)
      })
      result.push({ path: record.path, lines, fragments, hasMore: isTrue(record.hasMore) })
      return
    }
    Object.values(record).forEach(visit)
  }
  visit(value)
  return result
}

/** 间隔窗口分别作为复制目标，避免把不相邻的源码行拼接在一起。 */
export function projectSourceSegments(view: ProjectSourceView) {
  const segments: Array<{ label: string; lines: Array<[number, string]>; text: string; fragment: boolean }> = []
  for (const line of view.lines) {
    const last = segments.at(-1)
    if (last && !last.fragment && last.lines.at(-1)![0] + 1 === line[0]) {
      last.lines.push(line)
      last.text += `\n${  line[1]}`
      last.label = `${last.lines[0]![0]}–${line[0]}`
    } else segments.push({ label: String(line[0]), lines: [line], text: line[1], fragment: false })
  }
  for (const fragment of view.fragments) segments.push({
    label: `${fragment.line}:${fragment.columns[0]}–${fragment.columns[1]}`,
    lines: [[fragment.line, fragment.text]], text: fragment.text, fragment: true,
  })
  return segments.sort((a, b) => a.lines[0]![0] - b.lines[0]![0])
}
