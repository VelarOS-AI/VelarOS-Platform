/**
 * 字符串语义化辅助（显式函数形式）。
 *
 * 一律具名导出：本包作为 npm 库嵌入宿主，禁改 `globalThis` 与 `String.prototype`。
 */
import { isEmpty } from './array.js'

/** 是否为空或纯空白。 */
export function isBlank(value: string): boolean {
  return isEmpty(value.trim())
}

/**
 * 把切割位置挪到码点边界上，避免把一个代理对（emoji 等增补平面字符）切成两半。
 *
 * `index` 是 `slice` 的切口（第 `index` 个 UTF-16 单元之前）。只有切口正好落在
 * 「高位代理项 + 低位代理项」中间时才需要挪：`'backward'` 往前退一格（整对丢掉，截前缀时用），
 * `'forward'` 往后进一格（整对留下，截尾巴时用）。其余情况原样返回。
 */
export function clampToCodePointBoundary(
  value: string,
  index: number,
  bias: 'backward' | 'forward' = 'backward',
): number {
  if (index <= 0) return 0
  if (index >= value.length) return value.length

  // 0xd800–0xdbff 是高位代理项、0xdc00–0xdfff 是低位代理项，两者相邻才构成一个码点。
  const leading = value.charCodeAt(index - 1)
  const trailing = value.charCodeAt(index)
  const splitsPair =
    leading >= 0xd800 && leading <= 0xdbff && trailing >= 0xdc00 && trailing <= 0xdfff
  if (!splitsPair) return index

  return bias === 'forward' ? index + 1 : index - 1
}

/** 超出 `maxLen` 时截断并加省略号；切口按码点边界回退，不会切开代理对。 */
export function truncate(value: string, maxLen: number, ellipsis = '…'): string {
  if (value.length <= maxLen) return value

  return value.slice(0, clampToCodePointBoundary(value, maxLen)) + ellipsis
}

/** 取末尾最多 `maxChars` 个 UTF-16 单元；切口按码点边界前进，不会切开代理对。 */
export function takeTail(value: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (value.length <= maxChars) return value

  return value.slice(clampToCodePointBoundary(value, value.length - maxChars, 'forward'))
}
