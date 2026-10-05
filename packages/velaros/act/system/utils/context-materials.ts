import type { ContextContent } from '@velaros-ai/context'

/** 从原文区间中扣除已送达或本帧已选择的范围，保留每个缺口。 */
function uncovered(
  start: number,
  end: number,
  covered: ReadonlyArray<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  let ranges = start < end ? [{ start, end }] : []
  for (const seen of covered)
    ranges = ranges.flatMap((range) => {
      if (seen.end <= range.start || seen.start >= range.end) return [range]
      return [
        ...(range.start < seen.start ? [{ start: range.start, end: seen.start }] : []),
        ...(seen.end < range.end ? [{ start: seen.end, end: range.end }] : []),
      ]
    })
  return ranges
}

/** 补读页优先；重叠页共用一次正文份额，选择本身不推进真实送达证明。 */
export function contextMaterialPages(
  pages: ReadonlyMap<string, ContextContent>,
  visible: ReadonlyMap<string, ReadonlyArray<{ start: number; end: number }>>
): Array<{ page: ContextContent; start: number; end: number }> {
  const ordered = [...pages.values()].reverse()
  const unread = ordered.flatMap((page) =>
    uncovered(
      page.offset,
      page.offset + page.text.length,
      visible.get(page.record.ref.id) ?? []
    ).map((range) => ({ page, ...range }))
  )
  const candidates = unread.length
    ? unread
    : ordered.map((page) => ({ page, start: page.offset, end: page.offset + page.text.length }))
  const selected = new Map<string, Array<{ start: number; end: number }>>()
  return candidates.flatMap(({ page, start, end }) => {
    if (page.totalChars === 0 && !selected.has(page.record.ref.id)) {
      selected.set(page.record.ref.id, [])
      return [{ page, start, end }]
    }
    const seen = selected.get(page.record.ref.id) ?? []
    const ranges = uncovered(start, end, seen)
    selected.set(page.record.ref.id, [...seen, ...ranges])
    return ranges.map((range) => ({ page, ...range }))
  })
}
