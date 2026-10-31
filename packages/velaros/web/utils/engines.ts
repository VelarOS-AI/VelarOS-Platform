/**
 * 搜索引擎那一半：试的顺序、拼结果页地址、解开结果里的跳转链接、把原始结果整理成交给模型的结果、认验证页、两边都失败时的话。
 * 都是纯函数，不碰页面；页面里抓原始材料的脚本在 `page-scripts.ts`。
 */

import { isNonBlankString, truncate } from '@velaros-ai/core'

import type { WebEngineFailure, WebRawHit } from '../types/page.js'
import type { WebSearchEngineId, WebSearchResult } from '../types/web.js'

import { WebTuning } from './tuning.js'
import { httpUrl } from './urls.js'

/** 两个搜索引擎的结果页。 */
const SearchPages: Readonly<Record<WebSearchEngineId, string>> = Object.freeze({
  google: 'https://www.google.com/search',
  bing: 'https://www.bing.com/search',
})

/** 报错里怎么称呼两个搜索引擎。 */
const EngineNames: Readonly<Record<WebSearchEngineId, string>> = Object.freeze({
  google: 'Google',
  bing: 'Bing',
})

/** 验证页、人机验证页正文里常见的字样；只在一条结果都没认出来时拿来说明原因，免得正常结果里碰巧有这几个字就误判。 */
const BlockedPageText = Object.freeze([
  /unusual traffic/iu,
  /异常流量/u,
  /人机验证/u,
  /verify (?:that )?you are (?:a )?human/iu,
  /captcha/iu,
])
const RateLimitedPageText =
  /too many requests|rate limit(?:ed| exceeded)?|请求过于频繁|访问过于频繁/iu

/** 这次按什么顺序试搜索引擎：用户选的在前，另一个兜底（宿主报了别的值按 Google 算）。 */
export function engineOrder(preferred: WebSearchEngineId): WebSearchEngineId[] {
  return preferred === 'bing' ? ['bing', 'google'] : ['google', 'bing']
}

/** 报错里怎么称呼这个搜索引擎。 */
export function engineName(engine: WebSearchEngineId): string {
  return EngineNames[engine]
}

/** 拼结果页地址：Bing 用 count 要够条数；Google 一页十来条，不认条数参数。 */
export function searchPageUrl(engine: WebSearchEngineId, query: string, limit: number): string {
  const url = new URL(SearchPages[engine])
  url.searchParams.set('q', query)
  if (engine === 'bing') url.searchParams.set('count', String(limit))
  return url.href
}

/** 是不是 Google 的站：google.com 与 google.com.hk、google.co.jp 这类各地域名，含子域。 */
function isGoogleHost(hostname: string): boolean {
  return /(?:^|\.)google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/u.test(hostname)
}

/** 是不是 Bing 的站：www.bing.com、cn.bing.com 与 bing.com 本身。 */
function isBingHost(hostname: string): boolean {
  return hostname === 'bing.com' || hostname.endsWith('.bing.com')
}

/** 搜索引擎自己的页面（再搜一次、图片、跳转）：不算一条结果。 */
function isEnginePage(url: URL): boolean {
  if (isGoogleHost(url.hostname))
    return ['/search', '/url', '/imgres', '/sorry/'].some((path) => url.pathname.startsWith(path))
  if (isBingHost(url.hostname))
    return ['/search', '/ck/', '/images/', '/videos/'].some((path) => url.pathname.startsWith(path))
  return false
}

/** base64url 解成 UTF-8 文字；带了 base64url 以外的字符交回 null。 */
function decodeBase64Url(value: string): Nullable<string> {
  if (!/^[\w-]+={0,2}$/u.test(value)) return null
  return Buffer.from(value, 'base64url').toString('utf8')
}

/**
 * Bing 结果链接的真实目标：bing.com/ck/a 跳转链接的 u 参数是「a1」接上目标地址的 base64url；
 * 不是跳转链接的原样交回，解不出 http(s) 地址的交回 null。
 */
export function bingTarget(link: URL): Nullable<URL> {
  if (!isBingHost(link.hostname) || link.pathname !== '/ck/a') return link
  const encoded = link.searchParams.get('u') ?? ''
  const decoded = decodeBase64Url(encoded.startsWith('a1') ? encoded.slice(2) : encoded)
  return decoded ? httpUrl(decoded) : null
}

/**
 * 要问一次搜索引擎才知道真实地址的跳转链接：Google 的 `/goto?url=…`，参数是一串加密的令牌，本地解不开，
 * 服务端回一个 302 才知道跳去哪。
 */
export function needsResolving(href: string): boolean {
  const link = httpUrl(href)
  return !!link && isGoogleHost(link.hostname) && link.pathname === '/goto'
}

/** Google 结果链接的真实目标：/url?q=（或 url=）跳转链接取参数里的地址；不是跳转链接的原样交回，参数里没有 http(s) 地址的交回 null。 */
export function googleTarget(link: URL): Nullable<URL> {
  if (!isGoogleHost(link.hostname) || link.pathname !== '/url') return link
  const target = [link.searchParams.get('q'), link.searchParams.get('url')].find(isNonBlankString)
  return target ? httpUrl(target) : null
}

/**
 * 一条原始结果的目标地址：相对链接按结果页解开，再按搜索引擎解开跳转链接；
 * 最后要是 http 或 https、不是搜索引擎自己的页面。用不了交回 null。
 */
export function resultUrl(engine: WebSearchEngineId, href: string): Nullable<string> {
  const link = httpUrl(href, SearchPages[engine])
  if (!link) return null
  const target = engine === 'bing' ? bingTarget(link) : googleTarget(link)
  return target && !isEnginePage(target) ? target.href : null
}

/** 并空白、去首尾：页面已经做过一遍，这里再兜一次底。 */
function tidy(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** 去重用的键：只差 # 后面那一段的算同一个地址。 */
function dedupeKey(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.href
}

/**
 * 把抓到的原始结果整理成交给模型的结果：解开跳转链接、丢掉用不了的、按地址去重（留第一条）、截到 limit 条；
 * 标题空着的用地址顶上，标题与摘要各按上限截断。
 */
export function searchResults(
  engine: WebSearchEngineId,
  hits: readonly WebRawHit[],
  limit: number
): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (results.length >= limit) break
    const url = resultUrl(engine, hit.href)
    if (!url || seen.has(dedupeKey(url))) continue
    seen.add(dedupeKey(url))
    results.push({
      title: truncate(tidy(hit.title), WebTuning.search.titleChars) || url,
      url,
      snippet: truncate(tidy(hit.snippet), WebTuning.search.snippetChars),
    })
  }
  return results
}

/** 看地址就知道被拦了：落在 Google 的 /sorry/ 验证页或 consent.google.com 同意页上；交回一句原因，不是交回 null。 */
export function blockedAddress(pageUrl: string): Nullable<string> {
  const url = httpUrl(pageUrl)
  const sorry = url && isGoogleHost(url.hostname) && url.pathname.startsWith('/sorry/')
  return url && (sorry || url.hostname === 'consent.google.com')
    ? `被拦成了验证页或同意页（${url.origin}${url.pathname}）`
    : null
}

/**
 * 认出搜索引擎把这次搜索拦了下来：Google 的 /sorry/ 验证页与 consent.google.com 同意页看地址就知道（认没认出结果都算）；
 * 一条结果都没认出来时，再看正文开头有没有「unusual traffic」「异常流量」「人机验证」这类字样。认出来交回一句原因，没有交回 null。
 */
export function blockedReason(pageUrl: string, text: string, recognized: number): Nullable<string> {
  const address = blockedAddress(pageUrl)
  if (address) return address
  if (recognized > 0) return null
  const rateLimit = RateLimitedPageText.exec(text)?.[0]
  if (rateLimit) return `搜索来源暂时限流（页面上写着「${rateLimit}」）`
  const marker = BlockedPageText.map((pattern) => pattern.exec(text)?.[0]).find(isNonBlankString)
  return marker ? `被拦成了验证页（页面上写着「${marker}」）` : null
}

/** 两个搜索引擎都没搜成时交给模型的话：搜的是什么、每个为什么没成、接下来能怎么办。 */
export function searchFailedMessage(query: string, failures: readonly WebEngineFailure[]): string {
  const reasons = failures.map(({ engine, reason }) => `${engineName(engine)}：${reason}`)
  return `没搜成「${query}」。${reasons.join('；')}。可以过一会儿再试、换个说法再搜；已经知道网址的直接用 read 读。`
}
