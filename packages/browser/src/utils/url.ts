/** 解析外部 CDP 会话当前 URL，必要时回退。 */

import type { ExternalBrowserPageSession } from '../types/runtime.js'

export function resolveExternalPageUrl(
  session: ExternalBrowserPageSession,
  fallbackUrl: string
): string {
  return session.url || session.driver.getURL() || fallbackUrl
}
