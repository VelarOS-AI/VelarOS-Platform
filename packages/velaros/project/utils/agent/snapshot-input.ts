import {
  isArray,
  isBoolean,
  isEmpty,
  isNumber,
  isPlainObject,
  isString,
  isUndefined,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ProjectSnapshotLimits } from '../../contract/constants.js'
import type { ProjectSnapshotEntry, ProjectSnapshotInput } from '../../types/observation.js'
import { readLineRange } from '../editing/line-range.js'

/** 领域目录和真实捕获使用同一份计划核对；未知字段不能偷偷加入新的依赖。 */
export function snapshotInput(input: unknown): ProjectSnapshotInput {
  if (!isPlainObject(input) || Object.keys(input).some((key) => key !== 'files'))
    throw new AppError('VALIDATION', 'snapshot 只接受 files')
  if (
    !isArray(input.files) ||
    isEmpty(input.files) ||
    input.files.length > ProjectSnapshotLimits.files
  )
    throw new AppError('VALIDATION', `snapshot.files 需要 1 到 ${ProjectSnapshotLimits.files} 项`)
  const keys = new Set<string>()
  const files = input.files.map((item): ProjectSnapshotEntry => {
    if (
      !isPlainObject(item) ||
      Object.keys(item).some(
        (key) =>
          !['path', 'range', 'key', 'purpose', 'format', 'pointer', 'view', 'required'].includes(
            key
          )
      )
    )
      throw new AppError('VALIDATION', 'snapshot.files 项含未知字段')
    if (!isString(item.path) || !item.path.trim())
      throw new AppError('VALIDATION', 'snapshot.path 不能为空')
    if (
      !isString(item.key) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(item.key) ||
      item.key.length > ProjectSnapshotLimits.keyChars ||
      keys.has(item.key)
    )
      throw new AppError('VALIDATION', 'snapshot.key 必须是有界、不重复的输出名字')
    keys.add(item.key)
    if (
      !isString(item.purpose) ||
      !item.purpose.trim() ||
      item.purpose.length > ProjectSnapshotLimits.purposeChars
    )
      throw new AppError('VALIDATION', 'snapshot.purpose 必须说明当前阶段的观察目的')
    let range: ProjectSnapshotEntry['range']
    if (!isUndefined(item.range)) {
      const raw = item.range
      if (isNumber(raw)) range = raw
      else if (isArray(raw) && raw.length === 1 && isNumber(raw[0])) range = [raw[0]]
      else if (isArray(raw) && raw.length === 2 && isNumber(raw[0]) && isNumber(raw[1]))
        range = [raw[0], raw[1]]
      else throw new AppError('VALIDATION', 'snapshot.range 需要正整数、[行号] 或 [起始行,结束行]')
      readLineRange(range)
    }
    const format = item.format
    if (!isUndefined(format) && format !== 'text' && format !== 'json')
      throw new AppError('VALIDATION', 'snapshot.format 需要 text 或 json')
    const pointer = item.pointer
    if (
      !isUndefined(pointer) &&
      (!isString(pointer) ||
        pointer.length > ProjectSnapshotLimits.pointerChars ||
        (!isEmpty(pointer) && (!pointer.startsWith('/') || /~(?![01])/u.test(pointer))) ||
        format !== 'json')
    )
      throw new AppError('VALIDATION', 'snapshot.pointer 需要 json 格式的有界 JSON Pointer')
    const view = item.view
    if (!isUndefined(view) && view !== 'auto' && view !== 'full' && view !== 'reference')
      throw new AppError('VALIDATION', 'snapshot.view 需要 auto、full 或 reference')
    const required = item.required
    if (!isUndefined(required) && !isBoolean(required))
      throw new AppError('VALIDATION', 'snapshot.required 需要布尔值')
    const entry: { -readonly [Key in keyof ProjectSnapshotEntry]: ProjectSnapshotEntry[Key] } = {
      path: item.path,
      key: item.key,
      purpose: item.purpose,
    }
    if (!isUndefined(range)) entry.range = range
    if (!isUndefined(format)) entry.format = format
    if (!isUndefined(pointer)) entry.pointer = pointer
    if (!isUndefined(view)) entry.view = view
    if (!isUndefined(required)) entry.required = required
    return entry
  })
  return { files }
}
