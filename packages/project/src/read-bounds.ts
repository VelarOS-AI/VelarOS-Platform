// 域：读取请求里与具体文件无关的参数契约（范围形状、字节/字符上限）。
//
// FileStore 每次读取都会校验；批量读取的 Agent 适配层在逐文件循环之前先校验一次，
// 让调用级参数错误整体失败，而不是被拆成 N 条内容相同的逐文件 issue。错误里不带文件路径：
// 这类错误属于这次调用本身，与读哪个文件无关。
import { isUndefined } from '@velaros-ai/core'

import type { ReadInput } from './types/io.js'
import { ProjectError } from './errors.js'

export function validateReadBounds(input: Pick<ReadInput, 'range' | 'maxBytes' | 'maxChars'>): void {
  const { range } = input
  if (!isUndefined(input.maxBytes) && (!Number.isInteger(input.maxBytes) || input.maxBytes < 1))
    throw new ProjectError('INVALID_INPUT', 'maxBytes 必须是正整数', { maxBytes: input.maxBytes })
  if (!isUndefined(input.maxChars) && (!Number.isInteger(input.maxChars) || input.maxChars < 0))
    throw new ProjectError('INVALID_INPUT', 'maxChars 必须是非负整数', { maxChars: input.maxChars })
  if (!range) return
  const numericEntries = [
    ['startLine', range.startLine],
    ['endLine', range.endLine],
    ['startColumn', range.startColumn],
    ['endColumn', range.endColumn],
  ] as const
  for (const [name, value] of numericEntries) {
    if (!isUndefined(value) && (!Number.isInteger(value) || value < 1))
      throw new ProjectError('INVALID_INPUT', `${name} 必须是从 1 开始的正整数`, { range, field: name })
  }
  const startLine = range.startLine ?? 1
  if (!isUndefined(range.endColumn) && isUndefined(range.endLine))
    throw new ProjectError('INVALID_INPUT', '使用 endColumn 时必须同时提供 endLine', { range })
  if (!isUndefined(range.endLine) && range.endLine < startLine)
    throw new ProjectError('INVALID_INPUT', '读取范围的 endLine 不能早于 startLine', { range })
  if (
    (range.endLine ?? startLine) === startLine
    && !isUndefined(range.startColumn)
    && !isUndefined(range.endColumn)
    && range.endColumn < range.startColumn
  )
    throw new ProjectError('INVALID_INPUT', '同一行的 endColumn 不能早于 startColumn', { range })
}
