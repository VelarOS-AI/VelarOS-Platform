/** 网址：只认 http 与 https，别的协议与解析不了的一律当作没有。 */

import { toNullable } from '@velaros-ai/core'

/** 解析成 http 或 https 的地址（相对地址按 base 解）；别的协议、解析不了的交回 null。 */
export function httpUrl(value: string, base?: string): Nullable<URL> {
  if (!URL.canParse(value, base)) return null
  const url = new URL(value, base)
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
}

/** 页面现在落在哪个网页上：是 http 或 https 的地址就交回它的规范写法；还没落下（about:blank）、落在浏览器的出错页上交回 null。 */
export function landedUrl(current: string): Nullable<string> {
  return toNullable(httpUrl(current)?.href)
}
