/**
 * 记忆文件的格式：一条记忆一个 `<id>.md`，头部五个字段（title、description、type、tags、updated），空一行，再是 Markdown 正文。
 * 只读当前五字段格式；title、description 与 tags 用 JSON 编码，标点不会被当成 YAML 语法剥掉。
 */

import { createHash } from 'node:crypto'

import { isArray, isNull, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { MemoryEntry, MemorySaveInput } from '../types/memory.js'

import { isMemoryId, saveInput } from './input.js'

/** 记忆文件的扩展名。 */
const MemoryFileExtension = '.md'

/** 当前头部字段与固定次序；未知、缺失、重复字段都不能解释成别的记忆。 */
const HeaderFields = ['title', 'description', 'type', 'tags', 'updated'] as const

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

/** 只读当前格式；BOM 与文本换行可规范，版本始终取未经改写的原始内容。 */
export function parseMemoryFile(id: string, raw: string): MemoryEntry {
  try {
    const lines = normalizeText(raw).split('\n')
    if (lines[0] !== '---' || lines[6] !== '---' || lines[7] !== '')
      throw new AppError('VALIDATION', '需要当前五字段头部与空行分隔')
    const fields = HeaderFields.map((field, index) => {
      const prefix = `${field}: `
      const line = lines[index + 1]!
      if (!line.startsWith(prefix)) throw new AppError('VALIDATION', `头部需要 ${field} 字段`)
      return line.slice(prefix.length)
    })
    const [title, description, type, tagsText, updatedAt] = fields as [
      string,
      string,
      string,
      string,
      string,
    ]
    const tags: unknown = JSON.parse(tagsText)
    if (!isArray(tags)) throw new AppError('VALIDATION', '头部 tags 需要 JSON 字符串数组')
    const updated = Date.parse(updatedAt)
    if (!Number.isFinite(updated) || new Date(updated).toISOString() !== updatedAt)
      throw new AppError('VALIDATION', '头部 updated 需要完整 ISO 时间')
    const entry = saveInput({
      id,
      title: JSON.parse(title),
      description: JSON.parse(description),
      type,
      tags,
      content: lines.slice(8).join('\n'),
    })
    return { ...entry, tags: entry.tags!, revision: memoryRevision(raw), updatedAt }
  } catch (error) {
    throw new AppError('VALIDATION', `记忆 ${id} 的文件格式无效：${AppError.from(error).message}`)
  }
}

/** 把一条核对、规整过的记忆写成文件内容：头部五个字段，空一行，再是正文。updatedAt 是这次写入的时刻。 */
export function serializeMemoryFile(
  entry: MemorySaveInput & { tags: string[] },
  updatedAt: string
): string {
  return [
    '---',
    `title: ${JSON.stringify(entry.title)}`,
    `description: ${JSON.stringify(entry.description)}`,
    `type: ${entry.type}`,
    `tags: ${JSON.stringify(entry.tags)}`,
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

/** 原始持久内容的版本，含头部与更新时间；外部编辑也会产生新版本。 */
export function memoryRevision(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** 对锁内当前版本核验；省略版本是有意的最后提交覆盖，不暗中合并正文。 */
export function assertMemoryExpected(
  previous: Nullable<string>,
  expected: LooseOptional<string>
): void {
  if (!isUndefined(expected) && expected !== (isNull(previous) ? null : memoryRevision(previous)))
    throw new AppError(
      'CONFLICT',
      '记忆已经被别处更新；重新 list 读取最新 revision，再决定如何保存或删除'
    )
}
