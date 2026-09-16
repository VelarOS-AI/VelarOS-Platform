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
import { isIP } from 'node:net'

import { AppError } from '@velaros-ai/core/error'

/**
 * 把 IP 字面量归一成可比对的形态：去首尾空白，再剥掉 IPv6 在 URL 里惯用的方括号（`[::1]` → `::1`）。
 * 不剥方括号 `isIP` 就认不出来，整条 IPv6 黑名单会被静默绕过。
 * 非 IP 的字符串原样返回——这里只做形态归一，不做合法性校验。
 */
function normalizeIpLiteral(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * 把点分十进制字符串解析成四个 0–255 的整数；不是恰好四段、任一段不是纯数字或越界，一律返回 null。
 * 每段用 `/^\d+$/` 严格卡住而不是直接 `Number()`：后者会把 ` 10`、`0x7f`、`1e2` 这类写法也收下，
 * 而黑名单是按数值段判的，一个被宽松解析成"公网"的写法就足以穿门。
 */
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

/**
 * 从 IPv4-mapped IPv6 字面量里取出内嵌的 IPv4（`::ffff:10.0.0.1` → `10.0.0.1`）；不是这个形态返回 null。
 * 内嵌部分必须能解析成合法四段 IPv4 才认，否则 `::ffff:` 后跟任意串都会被当 IPv4 去判，反而判漏。
 * 这一步是 IPv4 黑名单不被绕过的前提：不折叠回 IPv4，`::ffff:10.0.0.1` 就会以 IPv6 形态走过整条 IPv4 规则。
 */
function readMappedIpv4(value: string): Nullable<string> {
  const normalized = normalizeIpLiteral(value).toLowerCase()
  const prefix = '::ffff:'
  if (!normalized.startsWith(prefix)) return null
  const candidate = normalized.slice(prefix.length)
  return readIpv4Octets(candidate) ? candidate : null
}

/**
 * 判一个 IPv4 是否落在**禁止取网**的网段。
 *
 * 为真的条件：10/8、172.16/12、192.168/16、169.254/16（含云元数据端点）、100.64/10（CGNAT）、
 * 全零的 `0.0.0.0`，以及 224.0.0/24 这段链路本地组播——这些要么是"别人的机器"，要么是模型本不该触达的基础设施。
 * **127/8 回环刻意放行**（返回 false）：宿主是跑在用户自己机器上的 Agent，"打开我刚起的本地服务看看"是常规任务，
 * 且本机场景下回环不构成额外提权。要收紧应由宿主注入策略，别在这里改成 true——那会静默掐掉本地预览与自测链路，
 * 症状只表现为"取网工具偶尔说拒绝访问内网"，极难关联回改动。
 * 解析不出合法 IPv4 时返回 false，把结论交回上层的主机名路径，不在这里替它下判断。
 */
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

/**
 * 判一个 IPv6 是否落在**禁止取网**的网段。
 *
 * 为真的条件：未指定地址 `::`、ULA（fc00::/7，即 fc / fd 开头）、链路本地（fe80::/10）、以及 `ff02:` 开头的链路本地组播。
 * **`::1` 回环刻意放行**，理由同 IPv4 的 127/8。
 * IPv4-mapped 形态先折回 IPv4 再按 IPv4 规则判——不折叠的话 `::ffff:10.0.0.1` 会整条绕过 IPv4 黑名单。
 * 比对在小写归一形上做（IPv6 字面量本就大小写无关）。
 */
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

/**
 * 出站取网的 IP 黑名单总入口：归一字面量（剥方括号）→ IPv4-mapped 先折回 IPv4 → 按 `isIP` 的结果分流到 v4 / v6 规则。
 * **压根不是 IP 时返回 false**——那说明目标是主机名，必须由调用方先 DNS 解析、再拿解析出的**每个**地址逐个问本函数；
 * 少了那一步，指向内网的公网域名与 DNS rebinding 会一律穿门。
 */
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

/**
 * 解析一个待取网的 URL 并把协议收在闭集里：解析失败、或协议不是 `http:` / `https:`，一律抛 `VALIDATION` 的 `AppError`（附原始 url）。
 * 只放行 http/https 是硬约束——`file:` / `data:` / 自定义 scheme 能让取网工具读本地文件或整个绕开网络门。
 * 过了这一关只说明**协议与格式**合法；目标地址可不可达仍要另走 IP 黑名单与逐跳复检。
 */
function parseSafeHttpUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    throw new AppError('VALIDATION', '取网地址必须是能解析的绝对 URL：请写成带 http:// 或 https:// 前缀的完整地址，相对路径和裸主机名都解析不出来。', error, {
      url: rawUrl,
    })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('VALIDATION', '取网地址只允许 http 或 https 协议：file:、data: 等协议能让取网工具读本地文件或绕开网络门，一律拒绝，请换成 http/https 地址。', undefined, {
      url: rawUrl,
      protocol: parsed.protocol,
    })
  }

  return parsed
}

export { isBlockedFetchIpAddress, normalizeIpLiteral, parseSafeHttpUrl }
