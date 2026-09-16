// SafeHttpFetch 用到的纯函数（不碰实例状态）。
import { lookup } from 'node:dns/promises'

/** 默认的主机名解析：取全部 A/AAAA 记录，逐个判黑。 */
export async function defaultLookupIpAddresses(hostname: string): Promise<string[]> {
  const resolved = await lookup(hostname, { all: true, verbatim: true })
  return resolved.map((entry) => entry.address)
}
