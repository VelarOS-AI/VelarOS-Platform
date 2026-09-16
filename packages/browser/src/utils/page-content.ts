import { randomBytes } from 'node:crypto'

import type { BrowserPageContentBoundary } from '../types/tools.js'

/** 给一段页面内容包上带 nonce 的边界，标明它来自哪个页面。 */
function createBrowserPageContentBoundary(url: string): BrowserPageContentBoundary {
  return {
    source: 'browser-page-content',
    origin: resolveOrigin(url),
    nonce: randomBytes(8).toString('hex'),
    fields: ['content'],
  }
}

/** 从地址里取出来源；地址不合法时退回整串。 */
function resolveOrigin(url: string): string {
  if (!URL.canParse(url)) return url

  return new URL(url).origin
}

export { createBrowserPageContentBoundary }
export type { BrowserPageContentBoundary } from '../types/tools.js'
