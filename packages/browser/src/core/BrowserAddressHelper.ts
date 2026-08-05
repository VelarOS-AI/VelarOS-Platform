import { optionalWhen } from '@velaros-ai/core/utils/optionalWhen'

import { DefaultBrowserSearchEngine } from './BrowserConfigDefaults.js'
import type { BrowserSearchEngineId } from './types.js'

const BrowserExplicitSchemePattern = /^[a-z][a-z0-9+.-]*:\/\//i
const BrowserLocalAddressPattern = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::|\/|$)/i
const BrowserWhitespacePattern = /\s/
const BrowserSearchUrlByEngine: Record<BrowserSearchEngineId, string> = {
  google: 'https://www.google.com/search',
  bing: 'https://www.bing.com/search',
}
const BrowserMultiPartPublicSuffixes = new Set([
  'co.uk',
  'com.au',
  'com.cn',
  'com.hk',
  'com.sg',
  'co.jp',
  'net.cn',
  'org.cn',
])

export function buildBrowserSearchUrl(
  query: string,
  searchEngine: BrowserSearchEngineId = DefaultBrowserSearchEngine
): string {
  return `${BrowserSearchUrlByEngine[searchEngine]}?q=${encodeURIComponent(query)}`
}

/** 给浏览器地址补齐可解析的默认协议。 */
export function getBrowserUrlCandidate(value: string): string {
  if (BrowserExplicitSchemePattern.test(value)) return value

  return `${BrowserLocalAddressPattern.test(value) ? 'http' : 'https'}://${value}`
}

/** 判断用户输入是否像一个可导航的浏览器地址。 */
export function isBrowserNavigationLikeInput(value: string): boolean {
  const input = value.trim()
  if (!input) return false
  if (BrowserExplicitSchemePattern.test(input)) return true
  if (BrowserWhitespacePattern.test(input)) return false
  if (BrowserLocalAddressPattern.test(input)) return true

  const hostCandidate = input.split(/[/?#]/, 1)[0] ?? ''
  if (!hostCandidate) return false
  if (/^\[[0-9a-f:.]+\](?::\d+)?$/i.test(hostCandidate)) return true

  return hostCandidate.includes('.')
}

/** 解析明确可导航的浏览器地址；无法确认是 URL 时返回 undefined。 */
export function resolveBrowserNavigationInput(
  input?: LooseOptional<string>
): LooseOptional<string> {
  const value = input?.trim()
  if (!value || !isBrowserNavigationLikeInput(value)) return undefined

  const candidate = getBrowserUrlCandidate(value)

  try {
    const parsedUrl = new URL(candidate)
    const supportedProtocol =
      parsedUrl.protocol === 'http:' ||
      parsedUrl.protocol === 'https:' ||
      parsedUrl.protocol === 'file:'

    return optionalWhen(supportedProtocol, parsedUrl.toString())
  } catch {
    // arch-guard:silent-catch-ok 地址候选无法被 URL 解析时按非导航输入处理。
    return undefined
  }
}

/** 按浏览器地址栏策略解析输入：URL 直接打开，普通关键词走配置的搜索引擎。 */
export function resolveBrowserSearchOrNavigationInput(
  input?: LooseOptional<string>,
  options: {
    searchEngine?: BrowserSearchEngineId
  } = {}
): LooseOptional<string> {
  const value = input?.trim()
  if (!value) return undefined

  return (
    resolveBrowserNavigationInput(value) ??
    buildBrowserSearchUrl(value, options.searchEngine ?? DefaultBrowserSearchEngine)
  )
}

/** Google 搜索加载失败时，生成等价 Bing 搜索 URL；非 Google 搜索不处理。 */
export function resolveBrowserSearchFallbackUrl(
  url?: LooseOptional<string>
): LooseOptional<string> {
  if (!url) return undefined

  try {
    const parsedUrl = new URL(url)
    const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, '')
    if (host !== 'google.com' || parsedUrl.pathname !== '/search') return undefined

    const query = parsedUrl.searchParams.get('q')?.trim()
    return query ? buildBrowserSearchUrl(query, 'bing') : undefined
  } catch {
    // arch-guard:silent-catch-ok fallback 只处理可解析 URL，解析失败表示无搜索兜底。
    return undefined
  }
}

/** 判断 URL 是否指向本机浏览器目标。 */
export function isLocalBrowserUrl(url: URL): boolean {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]'
  )
}

/** 从 hostname 中提取站点级 host，尽量处理常见二级公共后缀。 */
export function getBrowserSiteHost(hostname: string): Nullable<string> {
  const host = hostname.toLowerCase().replace(/^www\./, '')
  if (!host) return null

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host

  const labels = host.split('.').filter(Boolean)
  if (labels.length <= 2) return host

  const suffix = labels.slice(-2).join('.')
  return BrowserMultiPartPublicSuffixes.has(suffix) ? labels.slice(-3).join('.') : suffix
}
