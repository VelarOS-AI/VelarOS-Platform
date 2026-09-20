import { toNullable } from '@velaros-ai/core'

import type { BrowserLoginGatePort, BrowserSpacePort } from '../../contract/requires'
import type { BrowserLoginDetection, BrowserLoginGateRecord } from '../../types/browser'
import type { BrowserLoginGateOriginState } from '../../types/operations'
import {
  buildBrowserLoginGateMessage,
  buildBrowserLoginGateRecord,
  buildBrowserLoginGateRiskScope,
  resolveBrowserLoginGateOrigin,
} from '../../utils/login-gate'

/**
 * 登录墙门控：一个浏览器会话一份，既是**账本**也是**装饰器**。
 *
 * 检测启发式（`utils/page-scripts/login-detection.ts`）只回答「这一页看起来是不是登录 / 验证墙」；
 * 它单独存在时的产品行为是静默降级——截图元数据里多一句话，模型继续在登录页上瞎点。这个类补的
 * 是第二层：命中即**阻塞**，经宿主的 {@link BrowserLoginGatePort} 请用户人工完成登录，完成后重读
 * 页面并把结论标注回制品（渲染层读的就是 `loginGate`）。
 *
 * 账本语义是**每个站点最多问一次**：问过就记账，之后无论批准还是拒绝都不再阻塞。理由是死锁防护——
 * 用户点了「继续」但页面仍判定为登录墙（跳到了另一张验证页、或启发式误判）时，逐次重问会把会话钉死
 * 在一个永远过不去的门上；记账之后模型至少能带着结论收尾。账本是会话级、纯内存：登录态本身由全局
 * partition 持久化，门控只负责「这一轮要不要停下来等人」，不该反过来变成第二份登录态真相。
 *
 * 状态归调用方：一个浏览器会话建一个实例，装饰器与账本共用同一份状态，跨会话天然隔离。
 */
export interface BrowserLoginGateApi {
  /**
   * 把宿主端口包上门控后交回：只包 `inspectPage` 与 `captureScreenshot` 两条读页面内容的路。
   *
   * 为什么是装饰器而不是写进每个操作：门控要覆盖的是「观察到登录墙」这件事，而观察发生在
   * {@link BrowserSpacePort} 这一层；写进操作意味着每加一个观察类操作就要记得复制一遍门控，忘一次就是一条
   * 静默绕过。`navigatePage` / `getPageState` 不读正文，要检测就得额外发一次 `evaluateScript`，既多一次
   * 页面往返，又会撞上浏览器动作策略里 `evaluate` 那条门——导航后的登录墙由紧接着的 inspect / screenshot
   * 接住；click 一类动作同理：程序要拿到 target 就得先观察，观察即过门。
   */
  wrap(api: BrowserSpacePort): BrowserSpacePort
  /** 命中检测且该站点在本会话里从未问过时才阻塞。 */
  shouldPrompt(origin: string, detection: LooseOptional<BrowserLoginDetection>): boolean
  /** 该站点此前是否已经问过（供制品标注复用同一结论，避免同一轮里前后不一致）。 */
  getState(origin: string): Nullable<BrowserLoginGateOriginState>
}

export class BrowserLoginGate implements BrowserLoginGateApi {
  private readonly states = new Map<string, BrowserLoginGateOriginState>()
  /**
   * 同一站点的并发征询去重。
   *
   * 程序里可以同时发好几个 inspect（截图走会话队列），跨会话的调用也可能同时撞上同一个站点的登录墙，那就会弹两张卡；
   * 这里让后来者直接 await 同一次征询。
   */
  private readonly pendingByOrigin = new Map<string, Promise<BrowserLoginGateRecord>>()

  constructor(private readonly port: BrowserLoginGatePort) {}

  public wrap(api: BrowserSpacePort): BrowserSpacePort {
    const port = this.port
    return {
      ...api,
      inspectPage: async (inspectOptions) => {
        const inspection = await api.inspectPage(inspectOptions)
        const gate = await this.runGate(port, inspection.login, inspection.url)
        if (!gate) return inspection
        // 批准后重读：用户登录完成，旧那份正文是登录页，交给模型只会让它对着登录页作答。
        if (!gate.approved) return { ...inspection, loginGate: gate }
        return { ...(await api.inspectPage(inspectOptions)), loginGate: gate }
      },
      captureScreenshot: async (captureOptions) => {
        const artifact = await api.captureScreenshot(captureOptions)
        const gate = await this.runGate(port, artifact.metadata?.login, artifact.url)
        if (!gate) return artifact
        if (!gate.approved) return { ...artifact, loginGate: gate }
        return { ...(await api.captureScreenshot(captureOptions)), loginGate: gate }
      },
    }
  }

  public shouldPrompt(origin: string, detection: LooseOptional<BrowserLoginDetection>): boolean {
    if (!detection?.requiresLogin) return false
    return !this.states.has(origin)
  }

  public getState(origin: string): Nullable<BrowserLoginGateOriginState> {
    return toNullable(this.states.get(origin))
  }

  /** 走一次门控：没命中返回 null，命中则阻塞征询并返回要标注回制品的结论。 */
  private async runGate(
    port: BrowserLoginGatePort,
    detection: LooseOptional<BrowserLoginDetection>,
    url: LooseOptional<string>
  ): Promise<Nullable<BrowserLoginGateRecord>> {
    if (!detection?.requiresLogin) return null

    const origin = resolveBrowserLoginGateOrigin(url)
    const pending = this.pendingByOrigin.get(origin)
    if (pending) return pending
    if (!this.shouldPrompt(origin, detection)) return null

    this.states.set(origin, 'prompted')
    const gate = this.askUser(port, origin, detection, url)
    this.pendingByOrigin.set(origin, gate)
    try {
      return await gate
    } finally {
      this.pendingByOrigin.delete(origin)
    }
  }

  /** 阻塞征询用户一次并记账；没走到裁决（中止、宿主抛错）就撤销记账。 */
  private async askUser(
    port: BrowserLoginGatePort,
    origin: string,
    detection: BrowserLoginDetection,
    url: LooseOptional<string>
  ): Promise<BrowserLoginGateRecord> {
    let decision
    try {
      decision = await port.requestLoginCompletion({
        message: buildBrowserLoginGateMessage(detection, url),
        riskScope: buildBrowserLoginGateRiskScope(origin),
        origin,
        detection,
      })
    } catch (error) {
      // 记账在征询之前（防并发重复弹卡），中止 / 抛错必须撤销：没走到裁决就不算问过，
      // 否则用户中止一次之后，这个站点的登录墙再也拦不住 agent 了。
      this.states.delete(origin)
      throw error
    }
    this.states.set(origin, decision.approved ? 'approved' : 'declined')
    return buildBrowserLoginGateRecord({
      detection,
      url,
      approved: decision.approved,
      message: decision.message,
    })
  }
}

/**
 * 给宿主的工厂：一个浏览器会话建一份门控，用它把宿主端口包起来。
 *
 * 账本住在实例上，所以「每个站点最多问一次」的记账天然按会话隔离；跨会话共用一份实例
 * 等于让两个会话共享同一张「已经问过」的表。
 */
export function createBrowserLoginGate(port: BrowserLoginGatePort): BrowserLoginGateApi {
  return new BrowserLoginGate(port)
}
