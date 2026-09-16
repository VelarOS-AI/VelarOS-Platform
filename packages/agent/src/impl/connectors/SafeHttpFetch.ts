// 出站 HTTP 的 SSRF 安全门；判黑规则与非显然的妥协写在 utils/connectors/fetch-safety.ts 文件头。
import { isIP } from 'node:net'

import { AppError } from '@velaros-ai/core/error'

import type { SafeFetchOptions } from '../../types/connectors.js'
import { isBlockedFetchIpAddress, normalizeIpLiteral, parseSafeHttpUrl } from '../../utils/connectors/fetch-safety'
import { defaultLookupIpAddresses } from '../../utils/connectors/safe-http-fetch'

/**
 * 出站 HTTP 的 SSRF 安全门：协议只认 http/https，主机名解析成 IP 后逐个对内网黑名单判黑，重定向手动跟、每一跳都重新过门。
 *
 * 实现是 `SafeHttpFetch`，本文件里只建一个进程内共用实例（无状态，纯判定）；对外只经 `assertSafeHttpFetchUrl` / `safeFetch` 两个函数。
 * 拒绝一律抛 `AppError('VALIDATION', …)`，`details` 里带 `url`、`hostname`、命中的 `address`，给上层写日志和回话用。
 */
export interface SafeHttpFetchApi {
  /** 判一个 URL 能不能发：协议非法、目标是内网 IP、或主机名解析出的任一地址落在黑名单里都抛 `VALIDATION`；通过时返回解析好的 `URL`。发请求前和每跳重定向后都要过这道门。 */
  assertUrl(rawUrl: string, options?: SafeFetchOptions): Promise<URL>
  /** 发一次经安全门的请求：先判 `rawUrl`，再用 `redirect: 'manual'` 逐跳跟随，每跳的新地址都重新判一遍；跳数超过 `MaxRedirects` 抛 `VALIDATION`。返回的是第一个非重定向响应，HTTP 错误码不在这里处理。 */
  fetch(rawUrl: string, init?: RequestInit, options?: SafeFetchOptions): Promise<Response>
}

class SafeHttpFetch implements SafeHttpFetchApi {
  /** 最多跟这么多跳重定向，超了按 VALIDATION 拒绝。 */
  private static readonly MaxRedirects = 10

  /** 过门：协议合法、目标不在内网黑名单；返回解析好的 URL。 */
  public async assertUrl(rawUrl: string, options: SafeFetchOptions = {}): Promise<URL> {
    const parsed = parseSafeHttpUrl(rawUrl)
    const hostname = normalizeIpLiteral(parsed.hostname)

    if (isIP(hostname)) {
      if (isBlockedFetchIpAddress(hostname)) {
        throw new AppError(
          'VALIDATION',
          `拒绝抓取内网地址 ${hostname}：URL 直接指向内网或环回 IP，出站请求只允许发往公网主机。`,
          undefined,
          { url: rawUrl, hostname }
        )
      }
      return parsed
    }

    const lookupIpAddresses = options.lookupIpAddresses ?? defaultLookupIpAddresses
    const addresses = await lookupIpAddresses(hostname)
    const blockedAddress = addresses.find((address) => isBlockedFetchIpAddress(address))
    if (blockedAddress) {
      throw new AppError(
        'VALIDATION',
        `拒绝抓取内网地址 ${hostname}：它解析到内网或环回 IP ${blockedAddress}，出站请求只允许发往公网主机。`,
        undefined,
        { url: rawUrl, hostname, address: blockedAddress }
      )
    }

    return parsed
  }

  /** 发一次请求；每跳重定向都重新过门。 */
  public async fetch(
    rawUrl: string,
    init: RequestInit = {},
    options: SafeFetchOptions = {}
  ): Promise<Response> {
    let current = await this.assertUrl(rawUrl, options)

    for (let redirects = 0; redirects <= SafeHttpFetch.MaxRedirects; redirects += 1) {
      const response = await fetch(current.href, {
        ...init,
        redirect: 'manual',
      })
      const location = response.headers.get('location')
      const isRedirect = response.status >= 300 && response.status < 400 && !!location
      if (!isRedirect) return response

      current = await this.assertUrl(new URL(location, current).href, options)
    }

    throw new AppError(
      'VALIDATION',
      `重定向跳数超过 ${SafeHttpFetch.MaxRedirects} 仍未拿到最终响应：目标多半在重定向循环里，本次请求已中止。`,
      undefined,
      { url: rawUrl }
    )
  }
}

/** 进程内共用的安全门实例（无状态，纯判定）。 */
export const safeHttpFetch: SafeHttpFetchApi = new SafeHttpFetch()

/** 过门：协议合法、目标不在内网黑名单；返回解析好的 URL。 */
async function assertSafeHttpFetchUrl(rawUrl: string, options: SafeFetchOptions = {}): Promise<URL> {
  return safeHttpFetch.assertUrl(rawUrl, options)
}

/** 发一次经安全门的请求；每跳重定向都重新过门。 */
async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<Response> {
  return safeHttpFetch.fetch(rawUrl, init, options)
}

export { assertSafeHttpFetchUrl, safeFetch }
