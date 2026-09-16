/**
 * JSON 序列化辅助（显式函数形式）。
 *
 * 一律具名导出：本包作为 npm 库嵌入宿主，禁在 `JSON` 上挂静态扩展。
 */

import { isArray, isRecord, isUndefined } from '../typeGuards'

/** 环引用占位：指纹与诊断路径遇环降级成占位，不抛断调用方。 */
const CircularMarker = '[circular]'

/** 按默认两空格格式化 JSON。 */
export function stringifyPretty(
  value: unknown,
  replacer?: JsonStringifyReplacer,
  space: string | number = 2,
): string {
  return JSON.stringify(value, replacer as Parameters<typeof JSON.stringify>[1], space)
}

/**
 * 键排序后的紧凑 JSON 文本：同一份数据在任何机器上都得到同一串字节，供指纹、去重与缓存前缀比对用。
 *
 * 键按 UTF-16 码元序排（不用 `localeCompare`：它随 ICU 数据与 locale 变化，两台机器会排出不同顺序）；
 * `Date` 取 ISO 文本；`undefined` 字段整条略去（与 `JSON.stringify` 的对象语义一致）；遇环写占位。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value, new Set())) ?? 'null'
}

/** UTF-16 码元序比较：locale 无关，跨机器同序。 */
function compareByCodeUnit(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function toStableJsonValue(value: unknown, seen: Set<object>): unknown {
  if (value instanceof Date) return value.toISOString()

  if (isArray(value)) {
    if (seen.has(value)) return CircularMarker
    seen.add(value)
    const projected = value.map((item) => toStableJsonValue(item, seen))
    seen.delete(value)
    return projected
  }

  if (!isRecord(value)) return value

  if (seen.has(value)) return CircularMarker
  seen.add(value)
  const projected: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort(compareByCodeUnit)) {
    const entry = value[key]
    if (isUndefined(entry)) continue
    projected[key] = toStableJsonValue(entry, seen)
  }
  seen.delete(value)
  return projected
}
