/**
 * HTML 报告共用的零件：转义、有限数值与未知值的呈现。
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

/** 已知数值必须有限；坏数值不能变成正文，也不能冒充未知。 */
export function finiteNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error('报告数值必须是有限数字')
  return value
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
  if (typeof value === 'number') finiteNumber(value)
  else if (typeof value !== 'string') throw new Error('报告值必须是数字、文字或 null')
  const display = typeof value === 'number' && formatter ? formatter(value) : String(value)
  return `<span data-value="${escapeHtml(value)}">${escapeHtml(display)}</span>`
}

/** 把一个时间戳渲染成一格，未知就是破折号。 */
export function timestampCell(generatedAt: number | null): string {
  return generatedAt === null ? unknownCell() : escapeHtml(new Date(generatedAt).toISOString())
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
