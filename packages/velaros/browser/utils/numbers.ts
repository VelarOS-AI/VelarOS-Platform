import { isFiniteNumber, isString, optionalWhen } from '@velaros-ai/core'

/** 是有限数就原样返回，否则返回 undefined。 */
export function readFiniteNumber(value: unknown): number | undefined {
  return optionalWhen(isFiniteNumber, value)
}

/** 把一段文本压成单行并截到上限；空串返回 null。 */
export function readBoundedString(value: unknown, maxLength: number): Nullable<string> {
  if (!isString(value)) return null

  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

/**
 * 数值入参钳制族：**全包唯一实现**，页面脚本构造器与 engines 都从这里取。
 *
 * 为什么钳制而不是拒绝：这些值来自模型给的工具入参（超时、条数、字符上限、滚动距离）。
 * 越界一律夹回区间、缺席用 fallback，**不抛错**——拒绝会把「参数写大了一点」升级成一次
 * 完整的失败重试，而夹回后的行为对调用方仍然正确。
 *
 * 用 `isFiniteNumber` 而非 `Number.isFinite`：后者不是类型谓词，收窄不了 `number | undefined`，
 * 于是每份拷贝都要补一次 `value as number`——本包曾因此散着 7 份实现 + 14 处断言。
 */
export function clampNumber(
  value: LooseOptional<number>,
  min: number,
  max: number,
  fallback: number
): number {
  if (!isFiniteNumber(value)) return fallback

  return Math.min(Math.max(value, min), max)
}

/** 把整数入参夹进区间；缺席或不是有限数时用 fallback。 */
export function clampInteger(
  value: LooseOptional<number>,
  min: number,
  max: number,
  fallback: number
): number {
  if (!isFiniteNumber(value)) return fallback

  return Math.min(Math.max(Math.round(value), min), max)
}

/** 用 `Number()` 换成数后取成至少为 1 的整数（四舍五入）；换不出有限数时按 fallback 取，fallback 同样至少为 1。 */
export function clampPositiveInteger(value: unknown, fallback: number): number {
  const numberValue = Number(value)
  if (!isFiniteNumber(numberValue)) return Math.max(1, Math.round(fallback))

  return Math.max(1, Math.round(numberValue))
}

/** 页面缩放因子归一化（0.25–3，两位小数）。 */
export function clampZoomFactor(value: LooseOptional<number>, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback

  const normalized = Math.round(value * 100) / 100
  return Math.min(Math.max(normalized, 0.25), 3)
}
