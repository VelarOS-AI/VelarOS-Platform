/**
 * 规范 JSON：同样的数据在任何机器上给出同样一串字节，摘要才能跨机器比。
 */

/**
 * 把任意值序列化成与键序无关的 JSON：对象键按**码点**排序（不用 `localeCompare`，它跟区域设置走，
 * 同一份数据在不同机器上会排出不同顺序，摘要因此不一致，复跑被误报成「不可比」）。
 * `undefined` 一律写成 `null`，不写出 JSON 里根本没有的 `undefined` 字面量。
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const fields = Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`)
  return `{${fields.join(',')}}`
}
