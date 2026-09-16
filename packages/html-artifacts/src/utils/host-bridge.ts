/**
 * 浏览器宿主侧的小工具：尺寸归一化，以及从一条 `postMessage` 载荷里安全地读出需要的字段。
 * 沙箱发来的东西一律当不可信输入，读不出想要的形状就当没这条消息。
 */
import type { HtmlArtifactMessagePayload } from '../types/browser.js'

import { isFiniteNumber, isObject, isString } from './runtime-guards.js'

/** 把一个尺寸收成至少 1 像素的整数；不是正数就用缺省值。 */
export function normalizeDimension(value: Optional<number>, fallback: number): number {
  return isFiniteNumber(value) && value > 0 ? Math.max(1, Math.ceil(value)) : fallback
}

/** 从一条消息的 `data` 里读出带 `type` 的载荷；形状对不上返回 null。 */
export function readMessagePayload(value: unknown): Nullable<HtmlArtifactMessagePayload> {
  if (!value || !isObject(value)) return null
  const type = (value as { type?: unknown }).type
  return isString(type) ? (value as HtmlArtifactMessagePayload) : null
}

/** 把一个未知值当字符串读；不是字符串就当空串。 */
export function readString(value: unknown): string {
  return isString(value) ? value : ''
}
