/** 内嵌页面驱动里用不着实例状态的那部分：鼠标键位掩码、诊断条数钳制、框架树。 */

import type electron from 'electron'

import type { BrowserFrameInfo, BrowserMouseButton } from '../../types/browser'
import { BrowserTuning } from '../tuning'

/** 把鼠标键翻成 CDP 的 buttons 位掩码。 */
export function cdpMouseButtonsMask(button: BrowserMouseButton): number {
  if (button === 'right') return 2
  if (button === 'middle') return 4
  return 1
}

/** 内嵌页面读诊断的条数钳进合法区间。 */
export function clampEmbeddedDiagnosticLimit(value: unknown): number {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return 100

  return Math.max(
    1,
    Math.min(BrowserTuning.cdp.embeddedNetworkDiagnostics, Math.round(numberValue))
  )
}

/** 内嵌页面的框架树展平成一张表：id 是 frameTreeNodeId，顶层页面在最前；与顶层页面不同源的 iframe 记成 crossOrigin。 */
export function listWebContentsFrames(webContents: electron.WebContents): BrowserFrameInfo[] {
  const top = webContents.mainFrame
  return top.framesInSubtree.map((frame) => ({
    id: String(frame.frameTreeNodeId),
    parentId: frame.parent ? String(frame.parent.frameTreeNodeId) : null,
    url: frame.url,
    name: frame.name,
    crossOrigin: frame !== top && frame.origin !== top.origin,
  }))
}
