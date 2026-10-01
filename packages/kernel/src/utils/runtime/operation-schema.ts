import type { ErrorObject } from 'ajv'

import { isFalse, isUndefined } from '@velaros-ai/core'
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
import { AppError } from '@velaros-ai/core/error'

import type { OperationSchema } from '../../types/operations.js'

/** 生成值不可变的 JSON 副本，拒绝函数、循环、非有限数字和隐式丢失的字段。 */
export function immutableOperationJson<T>(value: T): T {
  const seen = new Set<object>()
  const copy = (item: unknown): unknown => {
    if (isNull(item) || isString(item) || isBoolean(item)) return item
    if (isFiniteNumber(item)) return item
    if ((!isObject(item) && !isNull(item)) || seen.has(item))
      throw new AppError('VALIDATION', '操作数据必须是无环 JSON 值')
    if (
      Object.getPrototypeOf(item) !== Object.prototype &&
      !isNull(Object.getPrototypeOf(item)) &&
      !isArray(item)
    )
      throw new AppError('VALIDATION', '操作数据必须是普通 JSON 对象')
    seen.add(item)
    const result = isArray(item)
      ? item.map(copy)
      : Object.fromEntries(Object.entries(item).map(([key, child]) => [key, copy(child)]))
    seen.delete(item)
    return Object.freeze(result)
  }
  return copy(value) as T
}

/** 稳定排列字段，使同一 JSON 参数获得同一指纹。 */
export function canonicalOperationJson(value: unknown): string {
  if (isArray(value)) return `[${value.map(canonicalOperationJson).join(',')}]`
  if (isPlainObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalOperationJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** 按规范化 JSON 生成实际用于调用去重与参数核对的摘要。 */
export async function operationFingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalOperationJson(value))
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 从同一 schema 生成静态声明；校验仍由运行时执行，数值与长度限制保留在描述中。 */
export function operationSchemaType(
  schema: OperationSchema,
  definitions: Readonly<Record<string, OperationSchema>> = schema.definitions ?? {},
  seen: ReadonlySet<string> = new Set()
): string {
  const render = (child: OperationSchema): string => operationSchemaType(child, definitions, seen)
  if (schema.$ref) {
    const name = schema.$ref.slice('#/definitions/'.length)
    return seen.has(name)
      ? 'unknown'
      : operationSchemaType(definitions[name]!, definitions, new Set([...seen, name]))
  }
  if (schema.not && isEmpty(Object.keys(schema.not))) return 'never'
  if (!isUndefined(schema.const)) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ') || 'never'
  if (schema.anyOf)
    return schema.anyOf
      .map(render)
      .map((type) => `(${type})`)
      .join(' | ')
  switch (schema.type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return isArray(schema.items)
        ? `[${(schema.items as readonly OperationSchema[]).map((item, index) => `${render(item)}${index >= (schema.minItems ?? (schema.items as readonly OperationSchema[]).length) ? '?' : ''}`).join(', ')}]`
        : `Array<${render((schema.items ?? {}) as OperationSchema)}>`
    case 'object': {
      const fields = Object.entries(schema.properties ?? {}).map(
        ([name, field]) =>
          `${JSON.stringify(name)}${schema.required?.includes(name) ? '' : '?'}: ${render(field)}`
      )
      if (!isFalse(schema.additionalProperties)) fields.push('[key: string]: unknown')
      return `{ ${fields.join('; ')} }`
    }
    default:
      return 'unknown'
  }
}

/**
 * 把 schema 校验的错误写成一句读得懂的话：哪个字段、错在哪（`gaps[0] 应当是 object；多了不认识的字段 targetChars`）。
 * 脚本执行之前只查语法，入参形状全靠这里当场报；原样的 Ajv JSON 要模型自己拆，常量联合还会一个分支报一条——
 * 同一位置的常量分支并成「只能是 …」。最多列 8 条，余下的只说还有几条。
 */
export function describeSchemaErrors(errors: Optional<Nullable<readonly ErrorObject[]>>): string {
  const all = errors ?? []
  const allowed = new Map<string, unknown[]>()
  for (const error of all)
    if (error.keyword === 'const')
      allowed.set(error.instancePath, [
        ...(allowed.get(error.instancePath) ?? []),
        (error.params as { allowedValue: unknown }).allowedValue,
      ])
  const lines: string[] = []
  const add = (line: string): void => {
    if (!lines.includes(line)) lines.push(line)
  }
  for (const error of all) {
    const where = schemaErrorPath(error.instancePath)
    const at = where ? `${where} ` : ''
    const params = error.params as Record<string, unknown>
    const choices = allowed.get(error.instancePath)
    if (error.keyword === 'const') {
      if (!all.some((item) => item.keyword === 'anyOf' && item.instancePath === error.instancePath))
        add(`${at}只能是 ${(choices ?? []).map((value) => JSON.stringify(value)).join(' / ')}`)
    } else if (error.keyword === 'anyOf')
      add(
        choices
          ? `${at}只能是 ${choices.map((value) => JSON.stringify(value)).join(' / ')}`
          : `${at}不符合任何一种允许的写法`
      )
    else if (error.keyword === 'additionalProperties')
      add(`${at}多了不认识的字段 ${String(params.additionalProperty)}`)
    else if (error.keyword === 'required')
      add(`${at}缺少必填字段 ${String(params.missingProperty)}`)
    else if (error.keyword === 'type') add(`${at}应当是 ${String(params.type)}`)
    else if (error.keyword === 'enum')
      add(
        `${at}只能是 ${(params.allowedValues as unknown[]).map((value) => JSON.stringify(value)).join(' / ')}`
      )
    else add(`${at}${error.message ?? error.keyword}`)
  }
  const shown = lines.slice(0, 8)
  return lines.length > shown.length
    ? `${shown.join('；')}；还有 ${lines.length - shown.length} 处`
    : shown.join('；')
}

/** JSON Pointer 写成程序里的样子：`/files/0/path` → `files[0].path`；整个入参是空串。 */
function schemaErrorPath(pointer: string): string {
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce(
      (path, segment) =>
        /^\d+$/u.test(segment) ? `${path}[${segment}]` : path ? `${path}.${segment}` : segment,
      ''
    )
}

/** 检查 schema 方言，遇到不支持的关键字当场拒绝，避免声明与运行时静默失配。 */
export function validateOperationSchema(
  schema: OperationSchema,
  definitions: Readonly<Record<string, OperationSchema>> = schema.definitions ?? {}
): void {
  const visit = (child: OperationSchema): void => validateOperationSchema(child, definitions)
  const keywords = new Set([
    '$ref',
    'definitions',
    'not',
    'type',
    'description',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'additionalItems',
    'enum',
    'const',
    'anyOf',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ])
  for (const key of Object.keys(schema))
    if (!keywords.has(key)) throw new AppError('VALIDATION', `不支持的 schema 关键字 ${key}`)
  if (
    schema.$ref &&
    (!/^#\/definitions\/[A-Za-z0-9_]+$/u.test(schema.$ref) ||
      !Object.hasOwn(definitions, schema.$ref.slice('#/definitions/'.length)))
  )
    throw new AppError('VALIDATION', 'schema 引用必须指向当前合同定义')
  for (const field of Object.values(schema.properties ?? {})) visit(field)
  if (isArray(schema.items)) (schema.items as readonly OperationSchema[]).forEach(visit)
  else if (schema.items) visit(schema.items as OperationSchema)
  if (schema.not) visit(schema.not)
  for (const field of Object.values(schema.definitions ?? {})) visit(field)
  if (isObject(schema.additionalProperties)) visit(schema.additionalProperties)
  for (const branch of schema.anyOf ?? []) visit(branch)
}

/** 只结束观察方的等待；底层任务和资源仍由生命周期持有者收束，迟到结果不能恢复写入资格。 */
export async function awaitOperationRead<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let cancel: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? new AppError('CANCELLED', '操作等待已取消'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
