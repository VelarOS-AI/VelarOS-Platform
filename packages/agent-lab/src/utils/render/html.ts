/**
 * 三份 HTML 报告共用的零件：转义、未知值的呈现、自包含核对。
 * 报告必须自包含：打开一个 HTML 文件就能看，不联网、不拉任何外部资源。
 * 纯渲染：不碰 Node 模块、不发请求。
 */

/** 把一段文字转义成可以直接放进 HTML 的样子。 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 转义之后再给协议头插一个软换行点，长链接不会把表格撑破。 */
export function visibleText(value: unknown): string {
  return escapeHtml(value).replace(
    /https?:\/\//gi,
    (match) => `${match.slice(0, 4)}<wbr>${match.slice(4)}`
  )
}

/** 未知值渲染成破折号，并在 `data-value` 上标明它是 null——核对时据此判断有没有拿 0 冒充未知。 */
export function unknownCell(): string {
  return '<span data-value="null">—</span>'
}

/** 把一个可能未知的值渲染成一格；给了格式化函数就按它显示，原值仍写在 `data-value` 上。 */
export function valueCell(
  value: number | string | null,
  formatter?: (value: number) => string
): string {
  if (value === null) return unknownCell()
  const display = typeof value === 'number' && formatter ? formatter(value) : String(value)
  return `<span data-value="${visibleText(value)}">${visibleText(display)}</span>`
}

/** 把一个时间戳渲染成一格，未知就是破折号。 */
export function timestampCell(generatedAt: number | null): string {
  return generatedAt === null ? unknownCell() : visibleText(new Date(generatedAt).toISOString())
}

/** 比例渲染成百分数，保留一位小数。 */
export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/** 毫秒渲染成人读得懂的时长：不到一秒给毫秒，不到一分钟给秒，再长给分钟。 */
export function duration(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`
  return `${(value / 60_000).toFixed(1)}m`
}

/** 找出这份 HTML 里所有会去拉外部资源的地方；返回的是错误码，不是给人读的话。 */
export function findExternalResourceViolations(html: string): readonly string[] {
  const violations: string[] = []
  if (/https?:\/\//i.test(html)) violations.push('external-url')
  if (/<(?:img|script|source|video|audio|iframe)\b[^>]*\bsrc\s*=/i.test(html))
    violations.push('external-src-attribute')
  if (/<link\b/i.test(html)) violations.push('link-tag')
  if (/<a\b[^>]*\bhref\s*=\s*["'](?!#)/i.test(html)) violations.push('external-href')
  if (/@import\b|url\s*\(|@font-face\b/i.test(html)) violations.push('external-css-resource')
  if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bimport\s*\(/i.test(html))
    violations.push('external-script-request')
  return violations
}

/** 核对一份报告是不是自包含、有没有把未知渲染成具体值；不合格当场抛错，不把坏报告写出去。 */
export function assertSelfContainedHtml(html: string): void {
  const violations = findExternalResourceViolations(html)
  if (violations.length > 0) throw new Error(`报告不是自包含的: ${violations.join(', ')}`)
  if (/\b(?:NaN|undefined)\b/.test(html)) throw new Error('报告里出现了 NaN 或 undefined')
  if (/data-value="null">(?:0|0\.0|false)</i.test(html))
    throw new Error('报告把未知值渲染成了一个具体值')
}
