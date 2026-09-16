/** 解析外部 CDP 会话当前 URL，必要时回退。 */

import type { ExternalBrowserPageSession } from '../types/runtime.js'

/** 读外部页面当前的地址，缓存与驱动都拿不到时用兜底地址。 */
export function resolveExternalPageUrl(
  session: ExternalBrowserPageSession,
  fallbackUrl: string
): string {
  return session.url || session.driver.getURL() || fallbackUrl
}
