/** 内嵌页面驱动里用不着实例状态的那部分：鼠标键位掩码、诊断条数钳制。 */

/** CDP MouseEvent buttons 位掩码：left=1、right=2、middle=4。 */
import type { BrowserMouseButton } from '../../types/browser'
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

  return Math.max(1, Math.min(BrowserTuning.cdp.embeddedNetworkDiagnostics, Math.round(numberValue)))
}
