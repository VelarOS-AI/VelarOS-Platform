import { isArray, isBoolean, isEmpty, isFiniteNumber, isNull, isNumber, isObject, isPlainObject, isString, isTrue } from '@velaros-ai/core'

import { HistoryPreviewPlaceholderHeaderPattern } from './historyPreviewPlaceholder'

const MaximumChars = 12_000
const MaximumStringChars = 900
const MaximumArrayItems = 100
const MaximumOmissions = 100
const LargeFields = new Set(['content', 'data', 'image', 'base64', 'latexSource', 'widget_code', 'html', 'svg', 'source', 'newContent', 'replacement', 'replace'])
const MetadataKeys = new Set(['__historyInputOmissions', '__historyInputRef', '__historyInputRecall', '__historyInputPreview', '__toolReceivedFullInput'])
const Omitted = Symbol('omitted historical input')
interface Omission {
  path: Array<string | number>
  jsonPath: string
  chars?: number
  items?: number
  ref?: string
}

function jsonPath(path: Array<string | number>): string {
  return path.reduce<string>((result, key) => isNumber(key)
    ? `${result}[${key}]` : /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
      ? `${result}.${key}` : `${result}[${JSON.stringify(key)}]`, '$')
}

/** 省略信息仅写入元数据，源码字段不会填入虚构的替代正文。 */
export function projectToolInputForHistory(input: Record<string, unknown>, toolCallId?: string): Record<string, unknown> {
  const ref = isString(input.__historyInputRef) ? input.__historyInputRef : toolCallId ? `input:${toolCallId}` : undefined
  const omissions: Omission[] = []
  const seen = new WeakSet<object>()
  const describeOmission = (path: Array<string | number>, detail: Pick<Omission, 'chars' | 'items'> = {}): Omission => {
    const result: Omission = { path, jsonPath: jsonPath(path), ...detail }
    if (ref) result.ref = ref
    return result
  }
  const omit = (path: Array<string | number>, detail: Pick<Omission, 'chars' | 'items'> = {}) => {
    if (omissions.length < MaximumOmissions) omissions.push(describeOmission(path, detail))
    return Omitted
  }
  if (isArray(input.__historyInputOmissions)) {
    for (const item of input.__historyInputOmissions.slice(0, MaximumOmissions)) {
      if (isPlainObject(item) && isArray(item.path) && item.path.every((key): key is string | number => isString(key) || Number.isSafeInteger(key))) {
        const detail: Pick<Omission, 'chars' | 'items'> = {}
        if (isNumber(item.chars)) detail.chars = item.chars
        if (isNumber(item.items)) detail.items = item.items
        omissions.push(describeOmission([...item.path], detail))
      }
    }
  }
  const visit = (value: unknown, path: Array<string | number>): unknown => {
    const field = path.at(-1)
    if (isString(value)) {
      if (HistoryPreviewPlaceholderHeaderPattern.test(value.trimStart())) return omit(path)
      if (field === 'widget_code' && value.length <= 8_000) return value
      const largeField = isString(field) && LargeFields.has(field) && value.length > 240
      if (largeField || value.length > MaximumStringChars || value.startsWith('data:')) return omit(path, { chars: value.length })
      return value
    }
    if (isNull(value) || isBoolean(value) || (isFiniteNumber(value))) return value
    if (!isObject(value) && !isNull(value)) return omit(path)
    if (seen.has(value) || path.length > 32) return omit(path)
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return omit(path)
    seen.add(value)
    if (isArray(value)) {
      // 保留数组坐标准确性；占位文字和空洞可能被误抄为真实参数。
      if (value.length > MaximumArrayItems) { seen.delete(value); return omit(path, { items: value.length }) }
      const checkpoint = omissions.length
      const items = Array.from(value, (item, index) => visit(item, [...path, index]))
      seen.delete(value)
      if (items.includes(Omitted)) { omissions.length = checkpoint; return omit(path, { items: value.length }) }
      return items
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && !isNull(Object.getPrototypeOf(value))) {
      seen.delete(value)
      return omit(path)
    }
    const projected: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (isEmpty(path) && MetadataKeys.has(key)) continue
      const next = visit(item, [...path, key])
      if (next !== Omitted) Object.defineProperty(projected, key, { value: next, enumerable: true, configurable: true, writable: true })
    }
    seen.delete(value)
    return projected
  }
  const metadata = (omitted: Omission[]) => {
    const result: Record<string, unknown> = {
    __toolReceivedFullInput: true,
    __historyInputOmissions: omitted,
    __historyInputRecall: 'Omitted fields are absent from this history view. Use context:recall with ref and jsonPath for their original values; this is not an executable input.',
    }
    if (ref) result.__historyInputRef = ref
    return result
  }
  if (isTrue(input.__historyInputPreview)) return {
    __historyInputPreview: true,
    ...metadata([describeOmission([])]),
  }
  const projected = visit(input, []) as Record<string, unknown>
  const result = !isEmpty(omissions) ? { ...projected, ...metadata(omissions) } : projected
  if (JSON.stringify(result).length <= MaximumChars) return result
  return { __historyInputPreview: true, ...metadata([describeOmission([])]) }
}
