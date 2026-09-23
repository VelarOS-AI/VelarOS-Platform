/** 站点这一关：要页面的操作一律先确认进了站点。 */

import { AppError } from '@velaros-ai/core/error'

import { BrowserErrorCodes } from '../contract/constants.js'
import type { BrowserOperationContext } from '../contract/requires.js'
import type { BrowserSiteContext } from '../types/browser.js'

/** 确认进了站点并交回站点上下文；没进就抛 `BROWSER_SITE_NOT_OPEN`，端口上碰页面的方法一次都不调。 */
export function requireOpenSite(ctx: BrowserOperationContext): BrowserSiteContext {
  const site = ctx.browser.isActive() ? ctx.browser.getContext() : null
  if (!site)
    throw new AppError(
      BrowserErrorCodes.siteNotOpen,
      '还没进站点：先 open({ url }) 打开要操作的网站，再做别的。'
    )
  return site
}
