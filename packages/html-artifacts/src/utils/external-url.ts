/**
 * 外链归一化：沙箱里的制品要打开一个链接时，先在这里过一道协议白名单。
 * 不合法的一律返回 null——`javascript:` 这类主动执行型 URL 永远到不了宿主的 `onLink`。
 */
import { HtmlArtifactExternalUrlProtocols } from '../contract/constants.js'
import type { NormalizeHtmlArtifactExternalUrlOptions } from '../types/html-artifacts.js'
import type { UrlConstructorLike, UrlLike } from '../types/internals.js'

import { isString } from './runtime-guards.js'

/** 把协议名归一化成小写并补上结尾冒号。 */
function normalizeProtocol(protocol: string): string {
  const normalized = protocol.trim().toLowerCase()
  return normalized.endsWith(':') ? normalized : `${normalized}:`
}

/** 算出这一次实际放行的协议集合；宿主没给就用常量表里的缺省。 */
function resolveAllowedProtocols(protocols: LooseOptional<readonly string[]>): Set<string> {
  const values = protocols?.length ? protocols : HtmlArtifactExternalUrlProtocols
  return new Set(values.map(normalizeProtocol).filter(Boolean))
}

/** 归一化一个外链：过了协议白名单就返回归一化后的绝对地址，否则返回 null。 */
export function normalizeHtmlArtifactExternalUrl(
  value: unknown,
  options: NormalizeHtmlArtifactExternalUrlOptions = {}
): Nullable<string> {
  if (!isString(value)) return null

  const trimmed = value.trim()
  if (!trimmed) return null

  const UrlConstructor = (globalThis as { URL?: UrlConstructorLike }).URL
  if (!UrlConstructor) return null

  let parsed: UrlLike
  try {
    parsed = new UrlConstructor(trimmed)
  } catch {
    // arch-guard:silent-catch-ok 非法 URL 是预期的验证失败，公开契约以 null 明确拒绝。
    return null
  }

  return resolveAllowedProtocols(options.allowedProtocols).has(parsed.protocol.toLowerCase())
    ? parsed.href
    : null
}
