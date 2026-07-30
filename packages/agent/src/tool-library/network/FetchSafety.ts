// 域：出站 HTTP 的 **SSRF 安全门**（模型驱动的取网请求在真正发出前的唯一拦截层）。
//
// **挡什么威胁**：模型可被页面内容、工具结果或用户粘贴的文本诱导去 fetch 一个内网地址，把宿主机
// 当跳板读取本不可达的资源（云元数据端点、内网服务、容器网络）。门开在这一层是因为**这是所有取网
// 工具唯一的共同出口**（宿主侧取网工具一律经 `safeFetch` / `assertSafeHttpFetchUrl`）；开在各工具
// 里就会随新工具增加而漏，而漏的那一个不会有任何门喊红。
//
// ## 关键不变量（改这些会破什么）
//  - **逐跳复检**：`redirect: 'manual'` + 每跳重新 `assertSafeHttpFetchUrl`。**不许**换回平台自动
//    重定向——那样只有第一跳被检查，一个公网 URL 302 到 `http://10.0.0.1/` 就直接穿门。这是本文件
//    最容易被「顺手简化」掉的一条。
//  - **主机名要解析后再判**：非 IP 形态的目标必须先 DNS 解析、对**每个**返回地址判黑，否则指向内网
//    的公网域名与 DNS rebinding 一律穿门。`lookupIpAddresses` 可注入，正是为了让这条能被构造级验证。
//  - **协议闭集**：只放行 http/https；`file:` / `data:` / 自定义 scheme 一律 VALIDATION 拒绝。
//  - **IPv4-mapped IPv6 先折叠**：`::ffff:10.0.0.1` 必须折回 IPv4 再判，否则整条 IPv4 黑名单被绕过。
//
// ## 非显然的妥协：**回环刻意放行**（127.0.0.0/8 与 `::1`）
// 这不是漏网，是产品裁决。宿主是跑在**用户自己机器上**的开发/自动化 Agent，常规任务就包含「打开我
// 刚起的本地服务看看」——把回环拉黑会让这类任务整类失效；而在本机 Agent 场景下回环不构成额外提权
// （模型本来就能经命令行工具访问本机）。**改动前先想清楚**：把 `case 127` 改成 `return true` 会静默
// 掐掉本地预览/自测链路，症状表现为「取网工具偶尔说拒绝访问内网」，极难关联回这次改动。真要收紧应由
// 宿主注入策略，不在此硬编码。
// 相对地，**非回环私有网段一律拉黑**（10/8、172.16/12、192.168/16、169.254/16 含云元数据、
// 100.64/10 CGNAT、IPv6 ULA fc00::/7 与链路本地 fe80::/10）——那些是「别人的机器」，不是「本机」。
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { AppError } from '@velaros-ai/core/error'

const MaxSafeFetchRedirects = 10

interface SafeFetchOptions {
  lookupIpAddresses?: (hostname: string) => Promise<readonly string[]>
}

function normalizeIpLiteral(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1)
  return trimmed
}

function readIpv4Octets(value: string): Nullable<[number, number, number, number]> {
  const parts = value.split('.')
  if (parts.length !== 4) return null

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN
    const value = Number(part)
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : NaN
  })
  if (octets.some((part) => Number.isNaN(part))) return null

  return octets as [number, number, number, number]
}

function readMappedIpv4(value: string): Nullable<string> {
  const normalized = normalizeIpLiteral(value).toLowerCase()
  const prefix = '::ffff:'
  if (!normalized.startsWith(prefix)) return null
  const candidate = normalized.slice(prefix.length)
  return readIpv4Octets(candidate) ? candidate : null
}

function isBlockedIpv4Address(value: string): boolean {
  const octets = readIpv4Octets(value)
  if (!octets) return false

  const [first, second] = octets
  switch (first) {
    case 127:
      return false
    case 10:
      return true
  }
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 169 && second === 254) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 0 && octets.every((part) => part === 0)) return true
  if (first === 224 && second === 0 && octets[2] === 0) return true

  return false
}

function isBlockedIpv6Address(value: string): boolean {
  const normalized = normalizeIpLiteral(value).toLowerCase()
  switch (normalized) {
    case '::1':
      return false
    case '::':
      return true
  }

  const mappedIpv4 = readMappedIpv4(normalized)
  if (mappedIpv4) return isBlockedIpv4Address(mappedIpv4)

  return (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith('ff02:')
  )
}

function isBlockedFetchIpAddress(value: string): boolean {
  const normalized = normalizeIpLiteral(value)
  const mappedIpv4 = readMappedIpv4(normalized)
  if (mappedIpv4) return isBlockedIpv4Address(mappedIpv4)

  switch (isIP(normalized)) {
    case 4:
      return isBlockedIpv4Address(normalized)
    case 6:
      return isBlockedIpv6Address(normalized)
    default:
      return false
  }
}

function parseSafeHttpUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    throw new AppError('VALIDATION', 'Fetch URL must be a valid absolute URL.', error, {
      url: rawUrl,
    })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('VALIDATION', 'Fetch URL must use http or https.', undefined, {
      url: rawUrl,
      protocol: parsed.protocol,
    })
  }

  return parsed
}

async function defaultLookupIpAddresses(hostname: string): Promise<string[]> {
  const resolved = await lookup(hostname, { all: true, verbatim: true })
  return resolved.map((entry) => entry.address)
}

async function assertSafeHttpFetchUrl(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<URL> {
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

async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<Response> {
  let current = await assertSafeHttpFetchUrl(rawUrl, options)

  for (let redirects = 0; redirects <= MaxSafeFetchRedirects; redirects += 1) {
    const response = await fetch(current.href, {
      ...init,
      redirect: 'manual',
    })
    const location = response.headers.get('location')
    const isRedirect = response.status >= 300 && response.status < 400 && !!location
    if (!isRedirect) return response

    current = await assertSafeHttpFetchUrl(new URL(location, current).href, options)
  }

  throw new AppError('VALIDATION', `Fetch URL redirected more than ${MaxSafeFetchRedirects} times.`, undefined, {
    url: rawUrl,
  })
}

export { assertSafeHttpFetchUrl, isBlockedFetchIpAddress, safeFetch }
export type { SafeFetchOptions }
