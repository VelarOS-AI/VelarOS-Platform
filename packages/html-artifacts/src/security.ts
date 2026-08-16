const DEFAULT_ALLOWED_EXTERNAL_URL_PROTOCOLS = ['http:', 'https:'] as const

interface UrlLike {
  href: string
  protocol: string
}

interface UrlConstructorLike {
  new (input: string): UrlLike
}

export interface NormalizeHtmlArtifactExternalUrlOptions {
  allowedProtocols?: readonly string[]
}

function normalizeProtocol(protocol: string): string {
  const normalized = protocol.trim().toLowerCase()
  return normalized.endsWith(':') ? normalized : `${normalized}:`
}

function resolveAllowedProtocols(
  protocols: readonly string[] | null | undefined
): Set<string> {
  const values = protocols?.length ? protocols : DEFAULT_ALLOWED_EXTERNAL_URL_PROTOCOLS
  return new Set(values.map(normalizeProtocol).filter(Boolean))
}

export function normalizeHtmlArtifactExternalUrl(
  value: unknown,
  options: NormalizeHtmlArtifactExternalUrlOptions = {}
): string | null {
  if (typeof value !== 'string') return null

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
