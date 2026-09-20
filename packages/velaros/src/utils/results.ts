/** 领域可选字段省略 undefined，void 转 null；非 JSON 值明确拒绝而不是悄悄变形。 */
export function normalizeCapabilityValue(value: unknown): unknown {
  const seen = new Set<object>()
  const copy = (item:unknown, root = false):unknown => {
    if (item === undefined && root) return null
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || seen.has(item) || (!Array.isArray(item) && ![Object.prototype,null].includes(Object.getPrototypeOf(item)))) throw Object.assign(new Error('领域结果必须是无环 JSON 数据'),{code:'OUTPUT_ENCODING'})
    seen.add(item)
    const next = Array.isArray(item) ? item.map(child=>copy(child,true)) : Object.fromEntries(Object.entries(item).filter(([,child])=>child !== undefined).map(([key,child])=>[key,copy(child)]))
    seen.delete(item)
    return next
  }
  return copy(value,true)
}
