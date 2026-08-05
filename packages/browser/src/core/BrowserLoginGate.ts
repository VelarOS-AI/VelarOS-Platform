import { toNullable } from '@velaros-ai/core'

import type { BrowserLoginDetection, BrowserLoginGateRecord } from './types'

/**
 * 登录墙**门控层**的宿主无关内核（检测层的下游、工具装饰层的上游）。
 *
 * 检测启发式（{@link ./BrowserLoginDetection}）只回答「这一页看起来是不是登录/验证墙」；
 * 它单独存在时的产品行为是**静默降级**——截图元数据里多一句话，模型继续在登录页上瞎点。
 * 本模块补的是判决里承诺的第二层：命中即**阻塞**，经宿主审批通道请用户人工完成登录，
 * 完成后重拍并把结果标注回制品（渲染层读的就是这个 `loginGate`）。
 *
 * 刻意不进 runtime：`ElectronBrowserRuntime` 是页面驱动，不认识审批通道；门控是**工具层**
 * 的会话语义。本模块因此只做纯决策与纯数据，端口由 `@velaros-ai/browser/tools` 的装饰器注入。
 *
 * 拦截三分法（docs/design-principles.md §7）：登录墙是「等待用户裁决的页面事件」，
 * 与 dialog / download / permission 同类，属交互阻塞，**不是**工作流拦截。
 */

/** 一个站点在本次会话里的门控状态；`origin` 解析失败时退化为整串 URL。 */
type BrowserLoginGateOriginState = 'prompted' | 'approved' | 'declined'

/** 每次门控询问的默认风险归组键；同一站点复用同一 riskScope，避免逐页重复弹卡。 */
const BrowserLoginGateRiskScopePrefix = 'browser-login-gate'

/** URL → 站点身份键。与空间 `identityStrategy: 'origin'` 同口径。 */
export function resolveBrowserLoginGateOrigin(url: LooseOptional<string>): string {
  const raw = url?.trim() ?? ''
  if (!raw) return ''
  // 解析失败（相对地址/畸形串）与不透明 origin（about:/data:/blob: 等，`URL.origin` 给字符串
  // 'null'）一律退化为整串：宁可分格过细多问一次，也不要把两个毫不相干的页面挤进同一格、
  // 于是第二个站点永不弹卡。
  if (!URL.canParse(raw)) return raw
  const origin = new URL(raw).origin
  return origin && origin !== 'null' ? origin : raw
}

/** 门控询问的风险归组键；同一站点的多次询问共用一个 scope。 */
export function buildBrowserLoginGateRiskScope(origin: string): string {
  return `${BrowserLoginGateRiskScopePrefix}:${origin || 'unknown'}`
}

/**
 * 面向用户的阻塞文案。
 *
 * 只讲三件事：卡在哪、需要你做什么、点确认之后会发生什么。**不**把 signals 原样倒给用户——
 * 那是排障字段，出现在确认卡里只会让人怀疑自己是不是被要求做技术判断。
 */
export function buildBrowserLoginGateMessage(
  detection: BrowserLoginDetection,
  url: LooseOptional<string>
): string {
  const origin = resolveBrowserLoginGateOrigin(url)
  const site = origin || '当前网站'
  const challenge = detection.signals.includes('human-challenge-text')
    ? '人机验证'
    : detection.signals.includes('auth-error-text')
      ? '会话已过期，需要重新登录'
      : '登录或身份验证'
  return [
    `${site} 停在${challenge}页面，浏览器任务无法继续。`,
    '请在受控浏览器窗口里人工完成，然后点「继续」——我会重新读取页面再往下做。',
    '如果不想继续，可以拒绝；我会带着「登录待处理」的结论收尾，而不是在登录页上乱点。',
  ].join('\n')
}

/**
 * 本次会话的登录门控账本。
 *
 * **每个站点最多问一次**：问过就记账，之后无论批准还是拒绝都不再阻塞。理由是死锁防护——
 * 用户点了「继续」但页面仍判定为登录墙（跳到了另一张验证页、或启发式误判）时，
 * 逐次重问会把会话钉死在一个永远过不去的门上；记账之后模型至少能带着结论收尾。
 *
 * 账本是**会话级**、纯内存：登录态本身由全局 partition 持久化（BrowserPartitionMaintenance），
 * 门控只负责「这一轮要不要停下来等人」，不该反过来变成第二份登录态真相。
 */
export class BrowserLoginGateLedger {
  private readonly states = new Map<string, BrowserLoginGateOriginState>()

  /** 命中检测且该站点从未问过时才阻塞。 */
  public shouldPrompt(origin: string, detection: LooseOptional<BrowserLoginDetection>): boolean {
    if (!detection?.requiresLogin) return false
    return !this.states.has(origin)
  }

  public markPrompted(origin: string): void {
    this.states.set(origin, 'prompted')
  }

  public markResolved(origin: string, approved: boolean): void {
    this.states.set(origin, approved ? 'approved' : 'declined')
  }

  /**
   * 撤销一次**没走到裁决**的记账（征询被中止、宿主抛错）。
   *
   * 记账发生在征询之前（防并发重复弹卡），所以中止会留下一个「问过了」的假事实：
   * 用户下一轮回来，同一个登录墙再也不会拦住 agent 了。没有裁决就不算问过。
   */
  public clear(origin: string): void {
    this.states.delete(origin)
  }

  /** 该站点此前是否已经问过（供制品标注复用同一结论，避免同一轮里前后不一致）。 */
  public getState(origin: string): Nullable<BrowserLoginGateOriginState> {
    return toNullable(this.states.get(origin))
  }
}

/** 构造要标注回制品的门控结论。 */
export function buildBrowserLoginGateRecord(input: {
  detection: BrowserLoginDetection
  url: LooseOptional<string>
  approved: boolean
  /** 用户拒绝或宿主无审批通道时的原因；批准时通常为 null。 */
  message?: LooseOptional<string>
}): BrowserLoginGateRecord {
  return {
    prompted: true,
    approved: input.approved,
    origin: resolveBrowserLoginGateOrigin(input.url) || null,
    confidence: input.detection.confidence,
    signals: [...input.detection.signals],
    reason: input.message?.trim() || input.detection.reason,
    resolvedAt: Date.now(),
  }
}
