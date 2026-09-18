/**
 * 记忆文件的格式：一条记忆一个 `<id>.md`，头部五个字段（title、description、type、tags、updated），空一行，再是 Markdown 正文。
 * 解析宽容：人手改过的文件（没有头部、CRLF、BOM、name 与 summary 这类别名、认不出的类别）照样读得出来，解析从不抛错。
 */

import { isBlank } from '@velaros-ai/core'

import { MemoryLimits, MemoryTypes } from '../contract/constants.js'
import type { MemoryEntry, MemorySaveInput, MemoryType } from '../types/memory.js'

/** 记忆文件的扩展名。 */
const MemoryFileExtension = '.md'

/** id 的写法：小写字母与数字，连字符只在中间。 */
const MemoryIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Windows 上当不了文件名的保留名，带不带扩展名都不行。 */
const WindowsReservedNames: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/** 头部的围栏行。 */
const FenceLine = /^-{3,}\s*$/u

/** 头部的一行 `键: 值`。 */
const FieldLine = /^\s*([A-Za-z_][\w-]*)\s*:\s?(.*)$/u

/** 头部键的别名：人手写的 name、summary、kind、modified 也认。 */
const FieldAliases: Readonly<Record<string, 'title' | 'description' | 'type' | 'tags' | 'updated'>> = Object.freeze({
  title: 'title',
  name: 'title',
  description: 'description',
  summary: 'description',
  type: 'type',
  kind: 'type',
  tags: 'tags',
  updated: 'updated',
  modified: 'updated',
})

/** 写头部时要加引号的值：开头是 YAML 的特殊字符或引号，或者中间有「: 」「 #」。 */
const NeedsQuoting = /^[#&*!|>%@`'"[{]|: | #/u

/** 是不是合法的记忆 id：小写字母、数字和连字符，不超长，也不是 Windows 的保留名。 */
export function isMemoryId(value: string): boolean {
  return value.length <= MemoryLimits.idChars && MemoryIdPattern.test(value) && !WindowsReservedNames.has(value)
}

/** 一条记忆的文件名。 */
export function memoryFileName(id: string): string {
  return `${id}${MemoryFileExtension}`
}

/** 从文件名认出 id：不是 `<合法 id>.md` 的文件（临时文件、`.scope`、手放进来的别的文件）都不算记忆。 */
export function memoryIdOfFile(fileName: string): Nullable<string> {
  if (!fileName.endsWith(MemoryFileExtension)) return null
  const id = fileName.slice(0, -MemoryFileExtension.length)
  return isMemoryId(id) ? id : null
}

/** 规整一组标签：去掉首尾空白、转小写、丢掉空的、去重，顺序照旧。 */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
}

/**
 * 读一个记忆文件。modifiedAt 是文件的修改时间，头部没有能用的 updated 时拿它顶上。
 * 没有头部时标题取 id、描述取正文第一行；认不出的类别当作 work；没有标签就是空的。
 */
export function parseMemoryFile(id: string, raw: string, modifiedAt: Date): MemoryEntry {
  const { fields, body } = splitFrontmatter(normalizeText(raw))
  const updated = Date.parse(fields.get('updated') ?? '')
  return {
    id,
    type: memoryTypeOf(fields.get('type') ?? ''),
    title: fields.get('title') || id,
    description: fields.get('description') || firstLine(body),
    tags: tagsOf(fields.get('tags') ?? ''),
    content: body,
    updatedAt: (Number.isFinite(updated) ? new Date(updated) : modifiedAt).toISOString(),
  }
}

/** 读一个记忆文件头部里的标签（规整过的）；没有头部或没写标签就是空的。 */
export function parseMemoryTags(raw: string): string[] {
  return tagsOf(splitFrontmatter(normalizeText(raw)).fields.get('tags') ?? '')
}

/** 把一条核对、规整过的记忆写成文件内容：头部五个字段，空一行，再是正文。updatedAt 是这次写入的时刻。 */
export function serializeMemoryFile(entry: Required<MemorySaveInput>, updatedAt: string): string {
  return [
    '---',
    `title: ${encodeValue(entry.title)}`,
    `description: ${encodeValue(entry.description)}`,
    `type: ${entry.type}`,
    `tags: ${entry.tags.join(', ')}`.trimEnd(),
    `updated: ${updatedAt}`,
    '---',
    '',
    entry.content,
    '',
  ].join('\n')
}

/** 按更新时间从新到旧排；同一时刻的按 id 排，结果稳定。 */
export function compareByRecency(left: MemoryEntry, right: MemoryEntry): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1
  return left.id < right.id ? -1 : 1
}

/** 去掉开头的 BOM，换行统一成 LF。 */
function normalizeText(raw: string): string {
  const text = raw.charCodeAt(0) === 0xfe_ff ? raw.slice(1) : raw
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

/** 把文件拆成头部字段（按别名归一，同名的键第一次出现的算数）与正文；头部没有闭合时整篇都是正文。 */
function splitFrontmatter(text: string): { fields: Map<string, string>; body: string } {
  const fields = new Map<string, string>()
  const lines = text.split('\n')
  const start = lines.findIndex((line) => !isBlank(line))
  const end = start >= 0 && FenceLine.test(lines[start]!) ? lines.findIndex((line, index) => index > start && FenceLine.test(line)) : -1
  if (end < 0) return { fields, body: text.trim() }
  for (const line of lines.slice(start + 1, end)) {
    const match = FieldLine.exec(line)
    const field = match ? FieldAliases[match[1]!.toLowerCase()] : undefined
    if (field && !fields.has(field)) fields.set(field, decodeValue(match![2] ?? ''))
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() }
}

/** 头部 tags 那一格拆成规整过的标签：逗号分隔，YAML 流式列表的方括号也认。 */
function tagsOf(value: string): string[] {
  return normalizeTags(value.replace(/^\[|\]$/gu, '').split(',').map(decodeValue))
}

/** 头部写的类别：认得的原样用，认不出的当作 work。 */
function memoryTypeOf(value: string): MemoryType {
  const type = value.trim().toLowerCase()
  return MemoryTypes.find((known) => known === type) ?? 'work'
}

/** 正文第一行有字的内容（去掉 Markdown 标题的井号），截到描述的上限。 */
function firstLine(body: string): string {
  const line = body.split('\n').map((text) => text.replace(/^\s*#{1,6}\s+/u, '').trim()).find(Boolean) ?? ''
  return line.slice(0, MemoryLimits.descriptionChars)
}

/** 读头部的一个值：首尾是同一种引号就剥掉，里面连写两遍的引号还原成一个。 */
function decodeValue(raw: string): string {
  const value = raw.trim()
  const quote = value[0]
  if (value.length < 2 || (quote !== "'" && quote !== '"') || !value.endsWith(quote)) return value
  return value.slice(1, -1).replaceAll(`${quote}${quote}`, quote)
}

/** 写头部的一个值：会被读歪的（开头是特殊字符或引号、中间有「: 」「 #」）用单引号包起来，里面的单引号连写两遍。 */
function encodeValue(value: string): string {
  return NeedsQuoting.test(value) ? `'${value.replaceAll("'", "''")}'` : value
}
