/**
 * 入参核对：入参来自模型的程序或宿主的代码，程序只查过语法、不查类型，形状、长度、换行、类别、id 的写法都在这里拦。
 * 不合法就当场拒绝（`VALIDATION`），一个文件都不写、不删；message 写清楚怎么改。
 */

import { isArray, isPlainObject, isPresent, isString, trimmedStringOrEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { MemoryLimits, MemoryTypes } from '../contract/constants.js'
import type { MemorySaveInput, MemoryType } from '../types/memory.js'

import { isMemoryId, normalizeTags } from './entry-file.js'

/**
 * 核对并规整 save 的入参：去掉首尾空白、标签规整好，多出来的字段不要。
 * 没给 tags 时交回的也没有这一项：沿用原来的标签还是空着，由作用域看这条原来有没有来定。
 */
export function saveInput(input: unknown): MemorySaveInput {
  if (!isPlainObject(input))
    throw new AppError(
      'VALIDATION',
      'save 要一个对象：{ id, type, title, description, tags?, content }'
    )
  const entry: MemorySaveInput = {
    id: memoryId(input.id),
    type: memoryType(input.type),
    title: lineField('title', input.title, MemoryLimits.titleChars),
    description: lineField('description', input.description, MemoryLimits.descriptionChars),
    content: contentField(input.content),
  }
  if (isPresent(input.tags)) entry.tags = tagsField(input.tags)
  return entry
}

/** 核对 remove 的入参，交回 id。 */
export function removeInput(input: unknown): string {
  if (!isPlainObject(input)) throw new AppError('VALIDATION', 'remove 要一个对象：{ id }')
  return memoryId(input.id)
}

/** id：小写字母、数字和连字符，不超长，不是 Windows 的保留名。 */
function memoryId(value: unknown): string {
  if (isString(value) && isMemoryId(value)) return value
  throw new AppError(
    'VALIDATION',
    `id 只能用小写字母、数字和连字符，最多 ${MemoryLimits.idChars} 个字符，也不能是 con、nul 这类 Windows 保留名；比如 reply-style`
  )
}

/** 类别：只认四个之一。 */
function memoryType(value: unknown): MemoryType {
  const type = MemoryTypes.find((known) => known === value)
  if (type) return type
  throw new AppError('VALIDATION', `type 只能是 ${MemoryTypes.join('、')} 之一`)
}

/** 一行的字段（标题、描述）：非空、不换行、不超长，去掉首尾空白。 */
function lineField(name: string, value: unknown, limit: number): string {
  const text = trimmedStringOrEmpty(value)
  if (!text) throw new AppError('VALIDATION', `${name} 要是非空的字符串`)
  if (/[\r\n]/u.test(text)) throw new AppError('VALIDATION', `${name} 不能换行，写成一行`)
  if (text.length > limit)
    throw new AppError('VALIDATION', `${name} 最多 ${limit} 个字符，这里有 ${text.length} 个`)
  return text
}

/** 正文：字符串，可以是空的，去掉首尾空白之后不超长。 */
function contentField(value: unknown): string {
  if (!isString(value)) throw new AppError('VALIDATION', 'content 要是字符串（可以是空的）')
  const text = value.trim()
  if (text.length > MemoryLimits.contentChars) {
    throw new AppError(
      'VALIDATION',
      `content 最多 ${MemoryLimits.contentChars} 个字符，这里有 ${text.length} 个；拆成几条记`
    )
  }
  return text
}

/** 标签：字符串数组，每个不含逗号和换行、不超长，规整之后不超过条数上限。 */
function tagsField(value: unknown): string[] {
  if (!isArray(value) || !value.every(isString))
    throw new AppError('VALIDATION', "tags 要是字符串数组，比如 ['发版', '提交']")
  for (const tag of value) {
    if (/[,\r\n]/u.test(tag))
      throw new AppError('VALIDATION', `标签「${tag}」里有逗号或换行；一个标签写一个主题`)
    if (tag.trim().length > MemoryLimits.tagChars)
      throw new AppError(
        'VALIDATION',
        `一个标签最多 ${MemoryLimits.tagChars} 个字符，「${tag}」超了`
      )
  }
  const tags = normalizeTags(value)
  if (tags.length > MemoryLimits.tagCount)
    throw new AppError(
      'VALIDATION',
      `一条最多 ${MemoryLimits.tagCount} 个标签，这里有 ${tags.length} 个`
    )
  return tags
}
