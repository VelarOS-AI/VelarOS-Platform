import type { ContextRef } from '@velaros-ai/context'
import { ContextLimits } from '@velaros-ai/context'
import { Log } from '@velaros-ai/core'
import { isArray, isEmpty, isPlainObject, isString, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { MemoryReadLimits } from '../../system/contract/constants.js'

/** 在已授权执行归档中选择真实字段，再按该字段的 UTF-16 字符分页；不读取原型属性。 */
export function readMaterialField(
  archived: string,
  pointer: string,
  offset = 0,
  limit: number = ContextLimits.readChars
): { text: string; totalChars: number; offset: number; pointer: string } {
  if (
    !isString(pointer) ||
    !pointer.startsWith('/') ||
    pointer.length > MemoryReadLimits.pointerChars ||
    /~(?![01])/u.test(pointer)
  )
    throw new AppError('VALIDATION', '执行结果字段路径必须是上限内的 JSON Pointer')
  let selected: unknown
  try {
    selected = JSON.parse(archived)
  } catch {
    throw new AppError('VALIDATION', '执行结果原文不是 JSON 归档')
  }
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
    if (
      (!isPlainObject(selected) && !isArray(selected)) ||
      (isArray(selected) && !/^(0|[1-9][0-9]*)$/u.test(key)) ||
      !Object.hasOwn(selected, key)
    )
      throw new AppError('NOT_FOUND', '执行结果中没有指定字段')
    selected = Reflect.get(selected, key)
  }
  const text = isString(selected) ? selected : JSON.stringify(selected)
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > text.length ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > ContextLimits.readChars
  )
    throw new AppError('INVALID_RANGE', '上下文范围必须是上限内的非负整数。')
  return { text: text.slice(offset, offset + limit), totalChars: text.length, offset, pointer }
}

/** 旧预览已截断时，从完整归档生成执行材料；保留诊断与真实字段路径，避免再次裁剪预览。 */
export function executionMaterial(archived: Readonly<Record<string, unknown>>): string {
  const result = optionalWhen(isPlainObject, archived.result)
  const captured =
    isPlainObject(archived.output) &&
    isArray(archived.output.blocks) &&
    !isEmpty(archived.output.blocks)
  const truncated =
    result &&
    isArray(result.notices) &&
    result.notices.some(
      (notice) => isPlainObject(notice) && notice.call === 'export' && notice.action === 'truncated'
    )
  const recover = truncated && (captured || Object.hasOwn(archived, 'rawValue'))
  return JSON.stringify({
    ...archived,
    dependencies: undefined,
    output: recover && captured ? archived.output : undefined,
    rawValue: recover && !captured ? archived.rawValue : undefined,
    result: recover ? { ...result, value: undefined } : archived.result,
  })
}

/** 投影大字段为可召回引用；原始脚本值和归档正文保持不变。 */
export function projectMaterial(text: string, ref: ContextRef, limit: number) {
  const size = {
    storedBytes: new TextEncoder().encode(text).byteLength,
    chars: text.length,
    unit: 'utf16',
  }
  const reference = (pointer: string, value: unknown) => {
    const read = {
      module: 'velaros:system',
      export: 'memory',
      operation: 'read',
      ref: ref.id,
    }
    if (pointer) Object.assign(read, { pointer })
    Object.assign(read, { rangeUnit: 'utf16' })
    return {
      ref,
      position: pointer || '/',
      representation: 'reference',
      bodyIncluded: false,
      // 带 pointer 的字符串召回为解码原文；根引用仍读取完整 JSON 归档。
      chars: pointer && isString(value) ? value.length : JSON.stringify(value).length,
      storedBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
      items: isArray(value) ? value.length : undefined,
      read,
      reason: 'view-budget',
    }
  }
  if (text.length <= limit)
    return {
      text,
      representation: 'full' as const,
      bodyIncluded: true,
      size,
      omitted: [] as string[],
    }
  const omitted: string[] = []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    Log.tag('ActRuntime').debug('materials 已进入异常处理或降级分支')
    return {
      text: text.slice(0, limit),
      representation: 'excerpt' as const,
      bodyIncluded: limit > 0,
      size,
      omitted: ['/'],
    }
  }
  let rootReference = false
  const shrink = (item: unknown, pointer: string, budget: number): unknown => {
    if (JSON.stringify(item).length <= budget) return item
    const metadata = reference(pointer, item)
    const before = omitted.length
    const fallback = () => {
      omitted.splice(before)
      omitted.push(pointer || '/')
      if (!pointer) rootReference = true
      return metadata
    }
    // 保留有界原文及其准确来源；不让一个大字符串把整层数组变成只有引用的回执。
    if (isString(item)) {
      const excerpt = (end: number) => ({
        ...metadata,
        representation: 'excerpt',
        bodyIncluded: true,
        text: item.slice(0, end),
        selection: { from: 0, shown: end, total: item.length, unit: 'utf16' },
        read: {
          ...metadata.read,
          ...(pointer
            ? { offset: end, limit: Math.min(ContextLimits.readChars, item.length - end) }
            : {}),
        },
      })
      let low = 0
      let high = Math.min(item.length, budget)
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (JSON.stringify(excerpt(middle)).length <= budget) low = middle
        else high = middle - 1
      }
      if (!low) return fallback()
      // 有换行时在完整行结束；单行值仍以明确的字符范围给出片段。
      const newline = item.lastIndexOf('\n', low - 1)
      if (newline > 0) low = newline + 1
      if (low < item.length && /[\uD800-\uDBFF]/.test(item[low - 1]!)) low--
      if (!low) return fallback()
      omitted.push(pointer || '/')
      return excerpt(low)
    }
    if (isArray(item)) {
      const values: unknown[] = []
      const excerpt = () => ({
        ...metadata,
        representation: 'excerpt',
        bodyIncluded: true,
        value: values,
        selection: { from: 0, shown: values.length, total: item.length, unit: 'items' },
      })
      for (let index = 0; index < item.length; index++) {
        // 预留逗号与 selection 中 shown 位数的增长，所有预算以最终 JSON 长度为准。
        const remaining = budget - JSON.stringify(excerpt()).length - 16
        if (remaining <= 0) break
        const childBefore = omitted.length
        const child = shrink(item[index], `${pointer}/${index}`, remaining)
        values.push(child)
        if (JSON.stringify(excerpt()).length > budget) {
          values.pop()
          omitted.splice(childBefore)
          break
        }
      }
      if (isEmpty(values)) return fallback()
      if (values.length < item.length) omitted.push(pointer || '/')
      return excerpt()
    }
    if (isPlainObject(item) && budget > 512) {
      const entries = Object.entries(item)
      const overhead =
        JSON.stringify(Object.fromEntries(entries.map(([key]) => [key, null]))).length -
        entries.length * 4
      let remaining = Math.max(0, budget - overhead)
      const allocations = new Map<string, number>()
      // 小元数据只占实际大小，余量交给大字段；平分外壳字段会浪费大部分正文预算。
      const ordered = entries
        .map(([key, child]) => ({ key, chars: JSON.stringify(child).length }))
        .sort((a, b) => a.chars - b.chars)
      for (const [index, entry] of ordered.entries()) {
        const allocated = Math.min(entry.chars, Math.floor(remaining / (ordered.length - index)))
        allocations.set(entry.key, allocated)
        remaining -= allocated
      }
      const projected = Object.fromEntries(
        entries.map(([key, child]) => [
          key,
          shrink(
            child,
            `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
            allocations.get(key)!
          ),
        ])
      )
      return JSON.stringify(projected).length <= budget ? projected : fallback()
    }
    return fallback()
  }
  const projected = JSON.stringify(shrink(value, '', limit))
  if (projected.length > limit)
    return {
      text: '',
      representation: 'reference' as const,
      bodyIncluded: false,
      size,
      omitted: ['/'],
    }
  return {
    text: projected,
    representation: rootReference ? ('reference' as const) : ('excerpt' as const),
    bodyIncluded: !rootReference,
    size,
    omitted,
  }
}
