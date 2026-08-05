import type { BrowserLoginDetection, BrowserLoginGateRecord } from '../core'
import {
  BrowserLoginGateLedger,
  buildBrowserLoginGateMessage,
  buildBrowserLoginGateRecord,
  buildBrowserLoginGateRiskScope,
  resolveBrowserLoginGateOrigin,
} from '../core'

import type { ToolBrowserApi } from './Types'

/**
 * 登录墙门控的**工具层装饰器**：检测命中 → 阻塞征询用户 → 用户完成后重读页面并标注。
 *
 * 为什么是装饰器而不是写进每个工具的 `execute`：门控要覆盖的是「观察到登录墙」这件事，
 * 而观察发生在 {@link ToolBrowserApi} 这一层；写进工具意味着每加一个观察类工具就要记得
 * 复制一遍门控，忘一次就是一条静默绕过（上一版就是这么丢的：门控随一个 600 行的
 * enhancer 整文件删除，检测层与渲染层却都留着，没有任何门会红）。
 *
 * 只包 `inspectPage` 与 `captureScreenshot` 两条**读页面内容**的路：
 *  - `navigatePage` / `getPageState` 不读正文，要检测就得额外发一次 `evaluateScript`，
 *    既多一次页面往返，又会撞上浏览器动作策略里 `evaluate` 那条门——用户关掉脚本执行权限
 *    不该让导航整条失效。导航后的登录墙由紧接着的 inspect / screenshot 接住。
 *  - `browser:act` 一类动作工具同理：模型要拿到 target 就得先观察，观察即过门。
 */

export interface BrowserLoginGateDecision {
  /** 用户是否表示「已完成登录，继续」。 */
  approved: boolean
  /** 拒绝原因或用户批注；批准时通常为空。 */
  message?: LooseOptional<string>
}

export interface BrowserLoginGatePort {
  /**
   * 阻塞当前工具调用并请用户人工完成登录/验证。
   *
   * 宿主实现应弹出**必须由用户亲自裁决**的确认卡（Desktop 走 ApprovalPort 的手动审批）。
   * 没有审批通道的宿主必须返回 `approved:false`，不能静默放行——那正是本层要补的洞。
   */
  requestLoginCompletion: (input: {
    message: string
    riskScope: string
    origin: string
    detection: BrowserLoginDetection
  }) => Promise<BrowserLoginGateDecision>
}

export interface BrowserLoginGateOptions {
  /** 会话级账本；不传则装饰器自己持有一份（每个会话一个 api 实例，天然隔离）。 */
  ledger?: BrowserLoginGateLedger
}

export function withBrowserLoginGate(
  api: ToolBrowserApi,
  port: BrowserLoginGatePort,
  options: BrowserLoginGateOptions = {}
): ToolBrowserApi {
  const ledger = options.ledger ?? new BrowserLoginGateLedger()
  /**
   * 同一站点的并发征询去重。
   *
   * `browser:inspect_page` 与 `browser:capture_screenshot` 都声明 `isConcurrencySafe: true`，
   * 两个并发调用同时撞上登录墙会弹两张卡；这里让后来者直接 await 同一次征询。
   */
  const pendingByOrigin = new Map<string, Promise<BrowserLoginGateRecord>>()

  const runGate = async (
    detection: LooseOptional<BrowserLoginDetection>,
    url: LooseOptional<string>
  ): Promise<Nullable<BrowserLoginGateRecord>> => {
    if (!detection?.requiresLogin) return null

    const origin = resolveBrowserLoginGateOrigin(url)
    const pending = pendingByOrigin.get(origin)
    if (pending) return pending
    if (!ledger.shouldPrompt(origin, detection)) return null

    ledger.markPrompted(origin)
    const gate = (async () => {
      let decision
      try {
        decision = await port.requestLoginCompletion({
          message: buildBrowserLoginGateMessage(detection, url),
          riskScope: buildBrowserLoginGateRiskScope(origin),
          origin,
          detection,
        })
      } catch (error) {
        // 记账在征询之前（防并发重复弹卡），中止/抛错必须撤销：没走到裁决就不算问过，
        // 否则用户中止一次之后，这个站点的登录墙再也拦不住 agent 了。
        ledger.clear(origin)
        throw error
      }
      ledger.markResolved(origin, decision.approved)
      return buildBrowserLoginGateRecord({
        detection,
        url,
        approved: decision.approved,
        message: decision.message,
      })
    })()
    pendingByOrigin.set(origin, gate)
    try {
      return await gate
    } finally {
      pendingByOrigin.delete(origin)
    }
  }

  return {
    ...api,
    inspectPage: async (inspectOptions) => {
      const inspection = await api.inspectPage(inspectOptions)
      const gate = await runGate(inspection.login, inspection.url)
      if (!gate) return inspection
      // 批准后重读：用户登录完成，旧那份正文是登录页，交给模型只会让它对着登录页作答。
      if (!gate.approved) return { ...inspection, loginGate: gate }
      return { ...(await api.inspectPage(inspectOptions)), loginGate: gate }
    },
    captureScreenshot: async (captureOptions) => {
      const artifact = await api.captureScreenshot(captureOptions)
      const gate = await runGate(artifact.metadata?.login, artifact.url)
      if (!gate) return artifact
      if (!gate.approved) return { ...artifact, loginGate: gate }
      return { ...(await api.captureScreenshot(captureOptions)), loginGate: gate }
    },
  }
}
