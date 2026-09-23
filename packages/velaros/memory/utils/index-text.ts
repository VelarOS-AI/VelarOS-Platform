/** 会话开场那段索引的排法：按类别分组、一行一条，放不下的只报条数，末尾列出现有标签。 */

import { isEmpty } from '@velaros-ai/core'

import { MemoryLimits, MemoryTypes } from '../contract/constants.js'
import type { MemoryEntry, MemoryType } from '../types/memory.js'

import { MemoryTuning } from './tuning.js'

/** 类别在索引里的小标题。 */
const MemoryTypeHeadings: Readonly<Record<MemoryType, string>> = Object.freeze({
  user: '用户',
  feedback: '反馈',
  work: '工作',
  reference: '参考',
})

/** 总是适用的类别：排索引时先放。 */
const AlwaysRelevantTypes: ReadonlySet<MemoryType> = new Set<MemoryType>(['user', 'feedback'])

/**
 * 排出会话开场的那段索引。entries 按更新时间从新到旧给（就是 list 交回的顺序）。
 * 先放 user 与 feedback，剩下的名额按更新时间给 work 与 reference；条数或字数到了上限就停，剩下的只报条数。
 */
export function renderMemoryIndex(entries: readonly MemoryEntry[]): string {
  if (isEmpty(entries)) return '## 记忆\n还没有记忆。'
  const listed = pickListed([
    ...entries.filter((entry) => AlwaysRelevantTypes.has(entry.type)),
    ...entries.filter((entry) => !AlwaysRelevantTypes.has(entry.type)),
  ])
  const lines = [`## 记忆（共 ${entries.length} 条，括号里是 id）`]
  for (const type of MemoryTypes) {
    const group = listed.filter((entry) => entry.type === type)
    if (!isEmpty(group)) lines.push(`### ${MemoryTypeHeadings[type]}`, ...group.map(indexLine))
  }
  const tags = tagLine(entries)
  if (tags) lines.push(tags)
  const omitted = entries.length - listed.length
  if (omitted > 0)
    lines.push(
      `另有 ${omitted} 条没列出，用 list() 看全部。条目太多了，合适的时候合并重复的、删掉过时的。`
    )
  return lines.join('\n')
}

/** 按优先顺序挑出列得下的条目：条数或字数再放一条就超的时候停。 */
function pickListed(ordered: readonly MemoryEntry[]): MemoryEntry[] {
  const listed: MemoryEntry[] = []
  let chars = 0
  for (const entry of ordered) {
    const length = indexLine(entry).length + 1
    if (
      listed.length >= MemoryTuning.index.maxEntries ||
      chars + length > MemoryTuning.index.maxChars
    )
      break
    listed.push(entry)
    chars += length
  }
  return listed
}

/** 索引里的一行：`- [标题](id) — 描述`，标题与描述压成一行、不超过各自的上限。 */
function indexLine(entry: MemoryEntry): string {
  return `- [${oneLine(entry.title, MemoryLimits.titleChars)}](${entry.id}) — ${oneLine(entry.description, MemoryLimits.descriptionChars)}`
}

/** 现有标签那一行：数全部条目里每个标签用了几次，从多到少取前面几个；一个标签都没有时是空串。 */
function tagLine(entries: readonly MemoryEntry[]): string {
  const counts = new Map<string, number>()
  for (const tag of entries.flatMap((entry) => entry.tags))
    counts.set(tag, (counts.get(tag) ?? 0) + 1)
  const top = [...counts]
    .sort(
      ([leftTag, leftCount], [rightTag, rightCount]) =>
        rightCount - leftCount || (leftTag < rightTag ? -1 : 1)
    )
    .slice(0, MemoryTuning.index.maxTags)
  return isEmpty(top) ? '' : `现有标签：${top.map(([tag, count]) => `${tag} ${count}`).join(' · ')}`
}

/** 把一段文字压成一行，超过上限就截断、末尾加省略号。 */
function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}
