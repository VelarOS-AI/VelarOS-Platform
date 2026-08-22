/**
 * 记忆文件的 frontmatter 解析 / 序列化。
 *
 * **宽容第一**：权威层的前提是「人可读、可手改」。用户和外部编辑器会写出 CRLF、BOM、
 * 缺失的 frontmatter、别名 key、带引号或不带引号的值、多余空行——这些一律不是错误，
 * 解析器负责把它们收进同一个形状。解析永不抛异常：一个手抖的记忆文件不该让整条召回炸掉。
 *
 * 三个一等字段（`name` / `description` / `type`）之外的 key 原样保留在 `attributes` 里并
 * 在写回时保序输出——后端不认识的字段是用户或未来档的资产，不许被静默吞掉。
 */

import { isBlank, isEmpty,isUndefined } from '@velaros-ai/core'

/** frontmatter 里的三个一等字段之外，后端自己也会写的保留 key（写回时保序在前）。 */
const ReservedAttributeOrder = [
  'id',
  'scope',
  'scopeType',
  'stableKey',
  'source',
  'sourceType',
  'trust',
  'privacy',
  'status',
  'created',
  'updated',
  'tags',
] as const

/** key 别名 → 一等字段。人手写的 `title:` / `summary:` / `kind:` 一律认。 */
const FieldAliases: Readonly<Record<string, 'name' | 'description' | 'type'>> = {
  name: 'name',
  title: 'name',
  heading: 'name',
  description: 'description',
  desc: 'description',
  summary: 'description',
  type: 'type',
  kind: 'type',
  category: 'type',
}

export interface MemoryFileDocument {
  readonly name: string
  readonly description: string
  readonly type: string
  /** 一等字段之外的 frontmatter 键值，按出现顺序保留。 */
  readonly attributes: Readonly<Record<string, string>>
  /** frontmatter 之后的正文（已 trim 首尾空行）。 */
  readonly body: string
  /** 该文件是否本来就带 frontmatter；false 表示三个一等字段是从正文推断出来的。 */
  readonly hadFrontmatter: boolean
}

const FrontmatterFence = /^-{3,}\s*$/u

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfe_ff ? raw.slice(1) : raw
}

function normalizeNewlines(raw: string): string {
  return raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

/** 去掉成对的引号；只在首尾**同种**引号时生效，避免吃掉正常的引号内容。 */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed.at(-1)
  if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1)
  return trimmed
}

function firstHeading(body: string): string {
  for (const line of body.split('\n')) {
    const match = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/u.exec(line)
    if (match) return match[1]
  }
  return ''
}

function firstParagraph(body: string): string {
  const paragraph: string[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (/^\s{0,3}#{1,6}\s+/u.test(line)) continue
    if (isEmpty(trimmed)) {
      if (!isEmpty(paragraph)) break
      continue
    }
    paragraph.push(trimmed)
    if (paragraph.join(' ').length > 240) break
  }
  return paragraph.join(' ')
}

/**
 * 解析一个记忆文件。
 *
 * @param raw 文件全文。
 * @param fallbackName 缺 name 且正文无标题时的兜底名（通常是文件名 slug）。
 */
export function parseMemoryFileDocument(
  raw: string,
  fallbackName = 'untitled',
): MemoryFileDocument {
  const text = normalizeNewlines(stripBom(raw ?? ''))
  const lines = text.split('\n')

  let cursor = 0
  while (cursor < lines.length && isBlank(lines[cursor].trim())) cursor += 1

  const fields = new Map<string, string>()
  let hadFrontmatter = false

  if (cursor < lines.length && FrontmatterFence.test(lines[cursor])) {
    const start = cursor + 1
    let end = -1
    for (let index = start; index < lines.length; index += 1) {
      if (FrontmatterFence.test(lines[index])) {
        end = index
        break
      }
    }
    // 只有闭合的 fence 才算 frontmatter；未闭合时整篇当正文，绝不吞掉用户内容。
    if (end >= 0) {
      hadFrontmatter = true
      for (const line of lines.slice(start, end)) {
        const match = /^\s*([A-Za-z_][\w-]*)\s*:\s?(.*)$/u.exec(line)
        if (!match) continue
        const key = match[1].trim()
        const value = unquote(match[2] ?? '')
        // 同名 key 重复出现时**首次**胜出：人手改多半是在上面补一行。
        if (!fields.has(key)) fields.set(key, value)
      }
      cursor = end + 1
    }
  }

  const body = lines.slice(cursor).join('\n').trim()

  let name = ''
  let description = ''
  let type = ''
  const attributes: Record<string, string> = {}
  for (const [key, value] of fields) {
    const canonical = FieldAliases[key.toLowerCase()]
    if (canonical === 'name' && !name) {
      name = value
      continue
    }
    if (canonical === 'description' && !description) {
      description = value
      continue
    }
    if (canonical === 'type' && !type) {
      type = value
      continue
    }
    if (!isUndefined(canonical)) continue
    attributes[key] = value
  }

  if (!name) name = firstHeading(body) || fallbackName
  if (!description) description = firstParagraph(body).slice(0, 400)
  if (!type) type = 'fact'

  return {
    name: name.trim() || fallbackName,
    description: description.trim(),
    type: type.trim().toLowerCase(),
    attributes,
    body,
    hadFrontmatter,
  }
}

/** frontmatter 值需要加引号的场景：首尾空白、以特殊标点开头、含换行。 */
function encodeValue(value: string): string {
  const normalized = value.replaceAll('\n', ' ').trim()
  if (isEmpty(normalized)) return "''"
  if (/^[#&*!|>%@`[{]/u.test(normalized) || normalized !== value) return `'${normalized.replaceAll("'", "''")}'`
  return normalized
}

export interface SerializeMemoryFileDocumentInput {
  readonly name: string
  readonly description: string
  readonly type: string
  readonly attributes?: Readonly<Record<string, string>>
  readonly body: string
}

/** 写回一个记忆文件。三个一等字段固定在前，保留字段按既定顺序，其余保序追加。 */
export function serializeMemoryFileDocument(
  input: SerializeMemoryFileDocumentInput,
): string {
  const attributes = { ...input.attributes }
  const lines = [
    '---',
    `name: ${encodeValue(input.name)}`,
    `description: ${encodeValue(input.description)}`,
    `type: ${encodeValue(input.type)}`,
  ]
  for (const key of ReservedAttributeOrder) {
    const value = attributes[key]
    if (isUndefined(value)) continue
    lines.push(`${key}: ${encodeValue(value)}`)
    delete attributes[key]
  }
  for (const [key, value] of Object.entries(attributes)) {
    lines.push(`${key}: ${encodeValue(value)}`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}\n${input.body.trim()}\n`
}
