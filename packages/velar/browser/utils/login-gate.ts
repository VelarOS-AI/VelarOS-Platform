import type { BrowserLoginDetection, BrowserLoginGateRecord } from '../types/browser.js'

/** 门控询问的默认风险归组键的前缀；键是「前缀:站点」，同一站点复用同一 riskScope，避免逐页重复弹卡。 */
export const BrowserLoginGateRiskScopePrefix = 'browser-login-gate'

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
