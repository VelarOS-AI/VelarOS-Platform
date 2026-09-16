/**
 * 确定性序列化原语（上下文治理 v2 · P7）。
 *
 * 判决依据：prompt 缓存按**前缀字节**匹配，单字节漂移毁掉整条下游缓存。所以凡是会进入 prompt
 * 或进入指纹的结构，序列化必须"同输入必同输出"：键排序钉死、清单顺序钉死、禁 locale 相关比较、
 * 禁时间戳/随机数混入。
 *
 * 否决记录：不用 `Array#sort` 的默认比较器之外的 `localeCompare`——它随 ICU 数据与 locale 变化，
 * 同一份账本在两台机器上会排出不同顺序（存量 `kernel/context-epoch.ts` 的 `sortedUnique` 正是
 * 这个形态，见 B0 报告 P7 审计清单）。本模块一律用 UTF-16 码元序。
 */
import { isArray, isRecord, isUndefined } from '@velaros-ai/core'

import { shortHash } from '../context/content-hash'

/** 环引用占位：序列化是诊断/指纹路径，遇环降级成占位而不是抛断整条 prompt 组装。 */
const CircularMarker = '[circular]'

/** UTF-16 码元序比较：locale 无关，跨机器同序。 */
export function compareStableStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** 去空白 + 去重 + 码元序排序：工具清单/锚点清单等"集合语义"的唯一渲染顺序。 */
export function sortedUniqueStrings(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean)
  return [...new Set(normalized)].sort(compareStableStrings)
}

/**
 * 按稳定键排序（同键保持输入相对序 —— `Array#sort` 在 V8 上已是稳定排序）。
 * 用于把 Map/Set 之类无序容器投影成确定序列。
 */
export function stableSortBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((left, right) => compareStableStrings(keyOf(left), keyOf(right)))
}

/** 键排序后的 JSON 文本：指纹、迁移事件落盘、账本快照共用。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value, new Set())) ?? 'null'
}

/** 稳定内容指纹：`stableStringify` + 短哈希，供账本快照与投影指纹比对。 */
export function stableFingerprint(value: unknown): string {
  return shortHash(stableStringify(value))
}

/**
 * 把任意值递归投影成"同输入必得同输出"的 JSON 可序列化结构：对象键按 UTF-16 码元序重排、
 * `undefined` 字段整条丢掉（JSON 本来也不保留它，显式丢弃让键集合稳定）、`Date` 转 ISO 串（不读当前时钟）。
 * 用 `seen` 沿路径记录正在展开的容器来防环：命中已在路径上的对象就写 `[circular]` 占位——
 * 序列化走的是诊断与指纹路径，遇环降级成占位远好过抛断整条 prompt 组装。
 * 出了这一层就从 `seen` 删掉，所以同一个对象在两个并列分支里重复出现会各自完整展开，不会被误判成环。
 */
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
  for (const key of Object.keys(value).sort(compareStableStrings)) {
    const entry = value[key]
    if (isUndefined(entry)) continue
    projected[key] = toStableJsonValue(entry, seen)
  }
  seen.delete(value)
  return projected
}
