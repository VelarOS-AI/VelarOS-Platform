import type { OperationSchema } from '../../types/operations.js'

/** 生成值不可变的 JSON 副本，拒绝函数、循环、非有限数字和隐式丢失的字段。 */
export function immutableOperationJson<T>(value: T): T {
  const seen = new Set<object>()
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || seen.has(item)) throw new Error('操作数据必须是无环 JSON 值')
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null && !Array.isArray(item)) throw new Error('操作数据必须是普通 JSON 对象')
    seen.add(item)
    const result = Array.isArray(item)
      ? item.map(copy)
      : Object.fromEntries(Object.entries(item).map(([key, child]) => [key, copy(child)]))
    seen.delete(item)
    return Object.freeze(result)
  }
  return copy(value) as T
}

/** 稳定排列字段，使同一 JSON 参数获得同一指纹。 */
export function canonicalOperationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOperationJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalOperationJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

/** 按规范化 JSON 生成实际用于调用去重与参数核对的摘要。 */
export async function operationFingerprint(value:unknown):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalOperationJson(value)))
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
}

/** 从同一 schema 生成静态声明；校验仍由运行时执行，数值与长度限制保留在描述中。 */
export function operationSchemaType(schema: OperationSchema, definitions: Readonly<Record<string,OperationSchema>> = schema.definitions ?? {}, seen: ReadonlySet<string> = new Set()): string {
  const render = (child:OperationSchema):string => operationSchemaType(child,definitions,seen)
  if (schema.$ref) {
    const name = schema.$ref.slice('#/definitions/'.length)
    return seen.has(name) ? 'unknown' : operationSchemaType(definitions[name]!,definitions,new Set([...seen,name]))
  }
  if (schema.not && Object.keys(schema.not).length === 0) return 'never'
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(' | ') || 'never'
  if (schema.anyOf) return schema.anyOf.map(render).map(type => `(${type})`).join(' | ')
  switch (schema.type) {
    case 'string': return 'string'
    case 'number': case 'integer': return 'number'
    case 'boolean': return 'boolean'
    case 'null': return 'null'
    case 'array': return Array.isArray(schema.items) ? `[${schema.items.map((item,index)=>`${render(item)}${index >= (schema.minItems ?? (schema.items as readonly OperationSchema[]).length) ? '?' : ''}`).join(', ')}]` : `Array<${render((schema.items ?? {}) as OperationSchema)}>`
    case 'object': {
      const fields = Object.entries(schema.properties ?? {}).map(([name, field]) => `${JSON.stringify(name)}${schema.required?.includes(name) ? '' : '?'}: ${render(field)}`)
      if (schema.additionalProperties !== false) fields.push('[key: string]: unknown')
      return `{ ${fields.join('; ')} }`
    }
    default: return 'unknown'
  }
}

/** 检查 schema 方言，遇到不支持的关键字当场拒绝，避免声明与运行时静默失配。 */
export function validateOperationSchema(schema: OperationSchema, definitions: Readonly<Record<string,OperationSchema>> = schema.definitions ?? {}): void {
  const visit = (child:OperationSchema):void => validateOperationSchema(child,definitions)
  const keywords = new Set(['$ref','definitions','not','type','description','properties','required','additionalProperties','items','additionalItems','enum','const','anyOf','minimum','maximum','minLength','maxLength','minItems','maxItems'])
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`不支持的 schema 关键字 ${key}`)
  if (schema.$ref && (!/^#\/definitions\/[A-Za-z0-9_]+$/u.test(schema.$ref) || !Object.hasOwn(definitions,schema.$ref.slice('#/definitions/'.length)))) throw new Error('schema 引用必须指向当前合同定义')
  for (const field of Object.values(schema.properties ?? {})) visit(field)
  if (Array.isArray(schema.items)) schema.items.forEach(visit)
  else if (schema.items) visit(schema.items as OperationSchema)
  if (schema.not) visit(schema.not)
  for (const field of Object.values(schema.definitions ?? {})) visit(field)
  if (typeof schema.additionalProperties === 'object') visit(schema.additionalProperties)
  for (const branch of schema.anyOf ?? []) visit(branch)
}
