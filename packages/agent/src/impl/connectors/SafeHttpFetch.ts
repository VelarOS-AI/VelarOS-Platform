// 出站 HTTP 的 SSRF 安全门；判黑规则与非显然的妥协写在 utils/connectors/fetch-safety.ts 文件头。
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { AppError } from '@velaros-ai/core/error'

import type { SafeFetchOptions } from '../../types/connectors.js'
import { isBlockedFetchIpAddress, normalizeIpLiteral, parseSafeHttpUrl } from '../../utils/connectors/fetch-safety'

/** 默认的主机名解析：取全部 A/AAAA 记录，逐个判黑。 */
async function defaultLookupIpAddresses(hostname: string): Promise<string[]> {
  const resolved = await lookup(hostname, { all: true, verbatim: true })
  return resolved.map((entry) => entry.address)
}

/**
 * 出站 HTTP 的唯一出口：协议闭集 + 解析后判黑 + 逐跳复检。
 *
 * 重定向**手动**跟（`redirect: 'manual'`），每一跳都重新过门——换回平台自动重定向只有第一跳被
 * 检查，一个公网 URL 302 到内网地址就直接穿门。
 */
class SafeHttpFetch {
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
          `refusing to fetch internal address ${hostname} (direct IP target)`,
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
        `refusing to fetch internal address ${hostname} (resolves to ${blockedAddress})`,
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
      `Fetch URL redirected more than ${SafeHttpFetch.MaxRedirects} times.`,
      undefined,
      { url: rawUrl }
    )
  }
}

/** 进程内共用的安全门实例。 */
const safeHttpFetch = new SafeHttpFetch()

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
