import { isTrue, isUndefined } from '@velaros-ai/core'
import {
  isArray,
  isBoolean,
  isEmpty,
  isFiniteNumber,
  isNull,
  isObject,
  isPlainObject,
  isString,
} from '@velaros-ai/core'

import type {
  ScriptOutputBlock,
  ScriptOutputCapture,
  ScriptOutputConfig,
  ScriptOutputOptions,
  ScriptOutputView,
} from '../types/output.js'

/** 校验纯数据声明；与同组纯数据守卫共同注入隔离堆，不开放宿主对象。 */
export function validateOutputOptions(value: unknown, config = false): void {
  const object = (v: unknown): v is Record<string, unknown> => Boolean(isPlainObject(v))
  const keys = (v: Record<string, unknown>, allowed: string[]) => {
    if (Object.keys(v).some((k) => !allowed.includes(k))) throw new Error('输出声明包含未知字段')
  }
  const integer = (v: unknown, max: number): v is number =>
    Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max
  if (!object(value)) throw new Error('输出声明必须是对象')
  if (config) {
    keys(value, ['maxChars'])
    if (!isUndefined(value.maxChars) && !integer(value.maxChars, 200000))
      throw new Error('maxChars 无效')
    return
  }
  keys(value, ['key', 'purpose', 'type', 'language', 'priority', 'required', 'view'])
  if (
    !isUndefined(value.key) &&
    (!isString(value.key) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value.key))
  )
    throw new Error('输出 key 无效')
  if (!isUndefined(value.purpose) && (!isString(value.purpose) || value.purpose.length > 1000))
    throw new Error('输出 purpose 无效')
  if (!isUndefined(value.language) && (!isString(value.language) || value.language.length > 80))
    throw new Error('输出 language 无效')
  if (
    !isUndefined(value.type) &&
    !['text', 'code', 'json', 'list', 'image', 'file'].includes(String(value.type))
  )
    throw new Error('输出 type 无效')
  if (!isUndefined(value.priority) && !['high', 'normal', 'low'].includes(String(value.priority)))
    throw new Error('输出 priority 无效')
  if (!isUndefined(value.required) && !isBoolean(value.required))
    throw new Error('输出 required 无效')
  if (isTrue(value.required) && !isString(value.key))
    throw new Error(
      '必需输出需要稳定 key；仅对决策必需的小值使用 {key:"state",required:true}，普通结果可省略 required'
    )
  if (isUndefined(value.view)) return
  if (!object(value.view)) throw new Error('view 必须是纯数据对象')
  const view = value.view
  keys(view, ['mode', 'maxChars', 'lines', 'maxItems', 'edge', 'paths'])
  if (
    !isUndefined(view.mode) &&
    !['auto', 'full', 'reference', 'summary'].includes(String(view.mode))
  )
    throw new Error('view.mode 无效')
  if (!isUndefined(view.maxChars) && !integer(view.maxChars, 200000))
    throw new Error('view.maxChars 无效')
  if (!isUndefined(view.maxItems) && !integer(view.maxItems, 1000000))
    throw new Error('view.maxItems 无效')
  if (!isUndefined(view.edge) && !['head', 'tail'].includes(String(view.edge)))
    throw new Error('view.edge 无效')
  if (
    !isUndefined(view.lines) &&
    (!isArray(view.lines) ||
      view.lines.length !== 2 ||
      !view.lines.every((v): v is number => integer(v, 10000000) && v > 0) ||
      view.lines[1] < view.lines[0])
  )
    throw new Error('view.lines 必须是一基闭区间')
  if (
    !isUndefined(view.paths) &&
    (!isArray(view.paths) ||
      view.paths.length > 64 ||
      view.paths.some(
        (v) =>
          !isString(v) ||
          v.length > 1000 ||
          (!isEmpty(v) && !v.startsWith('/')) ||
          /~(?:[^01]|$)/u.test(v)
      ))
  )
    throw new Error('view.paths 必须是 JSON Pointer 数组')
}

/** 调用时捕获快照并立即通知宿主，异常与中止不会丢失已完成的输出。 */
export function createOutputCollector(
  limits: {
    blocks: number
    rawChars: number
    metadataChars: number
    issues: number
    depth: number
  },
  validate: typeof validateOutputOptions,
  emit: (event: { config?: ScriptOutputConfig; block?: ScriptOutputBlock; issue?: string }) => void
) {
  let config: ScriptOutputConfig = {}
  let configured = false
  let chars = 0
  const blocks: ScriptOutputBlock[] = []
  const issues: string[] = []
  const names = new Set<string>()
  const fail = (message: string): never => {
    if (issues.length < limits.issues) {
      issues.push(message)
      emit({ issue: message })
    }
    throw new Error(message)
  }
  const copy = (v: unknown, seen = new Set<object>(), depth = 0, path = ''): unknown => {
    if (depth > limits.depth) throw new Error('输出嵌套过深')
    if (isNull(v) || isString(v) || isBoolean(v) || isFiniteNumber(v)) return v
    if (isUndefined(v))
      throw new Error(`输出字段 ${path || '/'} 是 undefined；请省略该字段或显式使用 null`)
    if (!v || !isObject(v)) throw new Error(`输出字段 ${path || '/'} 不是 JSON 值（${typeof v}）`)
    if (seen.has(v)) throw new Error(`输出需要无环 JSON 值：${path || '/'}`)
    if (!isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
      throw new Error('输出需要普通对象')
    seen.add(v)
    const result: Record<string, unknown> | unknown[] = isArray(v)
      ? Array.from({ length: v.length }, () => null)
      : Object.create(null)
    for (const key of Object.keys(v)) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!
      if (!('value' in descriptor)) throw new Error('输出不执行 getter')
      // 与 JSON 的可选字段语义一致：对象省略 undefined，数组位置保留为 null。
      if (isUndefined(descriptor.value)) continue
      Object.defineProperty(result, key, {
        value: copy(
          descriptor.value,
          seen,
          depth + 1,
          `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
        ),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    seen.delete(v)
    return result
  }
  const output = (value: unknown, options: ScriptOutputOptions = {}) => {
    try {
      if (blocks.length >= limits.blocks) throw new Error('输出块数量超限')
      const metadata = copy(options) as ScriptOutputOptions
      validate(metadata)
      if (JSON.stringify(metadata).length > limits.metadataChars) throw new Error('输出声明过大')
      const key = metadata.key ?? `$${blocks.length + 1}`
      if (names.has(key)) throw new Error(`输出 key 重复：${key}`)
      const raw = copy(isUndefined(value) ? null : value)
      const size = JSON.stringify(raw).length
      if (chars + size > limits.rawChars) throw new Error('输出采集上限已达到；此块没有完整归档')
      const type = metadata.type
      if (
        ((type === 'code' || type === 'text') && !isString(raw)) ||
        (type === 'list' && !isArray(raw))
      )
        throw new Error(
          `输出值与声明类型不匹配：type=${type} 要求${type === 'list' ? '数组' : '字符串'}，实际为${isNull(raw) ? 'null' : isArray(raw) ? '数组' : typeof raw}；对象或混合结果省略 type，或使用 type="json"`
        )
      if (
        (type === 'image' || type === 'file') &&
        (!isPlainObject(raw) || !((type === 'image' && 'data' in raw) || 'ref' in raw))
      )
        throw new Error('图片或文件输出需要原生图片或引用对象')
      const block = { key, options: metadata, value: raw, chars: size }
      names.add(key)
      chars += size
      blocks.push(block)
      emit({ block })
    } catch (error) {
      throw fail(error instanceof Error ? error.message : String(error))
    }
  }
  output.configure = (value: ScriptOutputConfig) => {
    try {
      if (configured || !isEmpty(blocks)) throw new Error('output.configure 必须在输出前调用一次')
      const data = copy(value) as ScriptOutputConfig
      validate(data, true)
      config = data
      configured = true
      emit({ config })
    } catch (error) {
      throw fail(error instanceof Error ? error.message : String(error))
    }
  }
  return {
    output: Object.freeze(output),
    snapshot: (): ScriptOutputCapture => ({ config, blocks, issues }),
  }
}

/** 给静态编辑和宿主重放共用同一 view 校验。 */
export function validateOutputView(view: ScriptOutputView): void {
  validateOutputOptions({ view })
}
