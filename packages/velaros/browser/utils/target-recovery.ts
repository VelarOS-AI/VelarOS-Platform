/** 点击的坐标恢复：selector 没找到元素时，在标注截图或元素矩形里找回唯一确定的那个元素，按坐标补点。 */

import { isFiniteNumber, isNull, isPlainObject, isPresent, isTrue } from '@velaros-ai/core'

import { BrowserEvaluateLimits } from '../contract/constants.js'
import type { BrowserOperationContext } from '../contract/requires.js'
import type {
  BrowserActed,
  BrowserActionEffectHint,
  BrowserElementTargetHint,
  BrowserScreenshotElementLabel,
  BrowserSelectorRecovery,
  BrowserTargetActionOptions,
  BrowserTargetActionOutcome,
} from '../types/browser.js'
import type { CoordinateClickPoint } from '../types/operations.js'

import { buildBrowserScreenshotOptions } from './screenshot-options'
import { scriptOutcomeValue } from './script-outcome.js'

/** 坐标恢复的探针截图路径：固定一份、每次覆盖写。 */
const BrowserTargetRecoveryScreenshotPath = 'artifacts/screenshots/recovery/target-action.png'

/**
 * selector 未命中时，尝试通过截图标注或 bounds 查询做坐标点击恢复。
 *
 * 坐标恢复的全仓唯一实现(战役四:增强层第二份同构恢复已删,那边只剩 blocker/effect
 * 纯注解)。历史教训:双份曾双向漂移(covered 短路/异常降级/abort 检查各修一边)——
 * 别再在别处复制本逻辑。
 */
export async function performTargetActionWithRecovery(
  action: BrowserTargetActionOptions & { action: 'click' | 'hover' },
  ctx: BrowserOperationContext
): Promise<BrowserActed> {
  const result: BrowserActed = {
    ...(await ctx.browser.performTargetAction(action)),
    action: action.action,
  }
  const actionEffect = buildTargetActionEffectRecovery(action, result)
  if (result.matched || action.action !== 'click')
    return actionEffect ? { ...result, actionEffect } : result

  // 坐标恢复只解决一种失败:**selector 没找到元素**。其余失败都不该走这里——
  // covered 的元素对同一中心点再点一次只会点中遮挡层,还会让增强层的 covered 指引
  // (targetBlocker)整条失效;not-interactable(display:none、宽高为 0、disabled)的元素
  // 本来就点不动,退到 bounds 兜底会拿到全 0 的矩形,在视口 (0,0) 点一下——那通常是站点
  // logo,等于把页面导航回首页,还回执 matched:true 告诉模型点成功了。
  // 口径与 CdpInteractionEngine.selfHealTargetActionAfterNotFound 一致。
  if (result.failureReason !== 'not-found') return result

  // 带 frame 提示的 target 不做坐标恢复:恢复只在顶层文档里找同名元素,跨 frame 会点错。
  if (action.target.frame) return result

  try {
    const recovery = await tryCoordinateRecovery(action.target, ctx)
    if (!recovery) return result

    return {
      ...result,
      matched: true,
      selectorRecovery: recovery,
    }
  } catch (error) {
    // 恢复本身失败(页面跳走/target 销毁等)不升级为操作错误:
    // 手里已有结构化 miss 结果与 nextActions 指引,退回它;用户中止照常外抛。
    if (ctx.abortSignal.aborted) throw error
    return result
  }
}

/** 点击没命中时，按效果指纹判断要不要再试一次、怎么试。 */
function buildTargetActionEffectRecovery(
  action: BrowserTargetActionOptions,
  result: BrowserTargetActionOutcome
): Nullable<BrowserActionEffectHint> {
  const effect = result.effect
  if (action.action !== 'click') return null
  if (!result.matched || !effect?.observed) return null
  if (effect.urlChanged || effect.titleChanged || effect.textChanged) return null

  return {
    source: 'target-action-effect',
    reason: 'no-observable-change',
    recommendedNextActions: ['inspect', 'screenshot'],
  }
}

/** 按坐标做一次兜底点击；只在身份确定的唯一匹配上做，零尺寸元素一律不做。 */
async function tryCoordinateRecovery(
  target: BrowserElementTargetHint,
  ctx: BrowserOperationContext
): Promise<Nullable<BrowserSelectorRecovery>> {
  ctx.abortSignal.throwIfAborted()

  const screenshot = await ctx.browser.captureScreenshot(
    buildBrowserScreenshotOptions({
      // 恢复截图是一次性探针:只用它的 elementLabels 找坐标,图本身没人回看。
      // 固定路径覆盖写,不再每次恢复都往工作区扔一个新文件(带时间戳的老写法会攒满
      // artifacts/screenshots/recovery/);也不要面向模型的压缩图——那会再落一个文件、
      // 再往回执里塞一份 base64。
      path: BrowserTargetRecoveryScreenshotPath,
      modelFacing: false,
      includeModelImage: false,
      annotateElements: true,
    })
  )
  const labels = screenshot.metadata?.elementLabels ?? []
  const clickPoint =
    findClickPointFromLabels(labels, target) ?? (await findClickPointFromBounds(target, ctx))
  if (!clickPoint) return null

  // 截图 await 期间可能已中止:坐标点击是带副作用的落子,落前必须再查。
  ctx.abortSignal.throwIfAborted()
  await ctx.browser.clickCoordinates({
    x: clickPoint.x,
    y: clickPoint.y,
  })

  return {
    source: 'selector-coordinate-recovery',
    screenshotPath: screenshot.relativePath,
    x: clickPoint.x,
    y: clickPoint.y,
  }
}

/** 从标注图的标签里找回目标元素的位置。 */
function findClickPointFromLabels(
  labels: BrowserScreenshotElementLabel[],
  target: BrowserElementTargetHint
): Nullable<CoordinateClickPoint> {
  const ranked = labels
    .map((label, index) => {
      const score = scoreElementLabel(label, target)
      return isNull(score) ? null : { label, index, score }
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .sort((left, right) => right.score - left.score || left.index - right.index)
  const matched = ranked[0]
  if (!matched) return null

  // 同等身份信号命中多个截图元素时，坐标就是有歧义的；不能按 DOM 顺序点第一个。
  if (ranked.slice(1).some((entry) => entry.score === matched.score)) return null

  // 零尺寸的标注框给不出可点的位置（中心点等于左上角），与 bounds 兜底同一条判据。
  if (matched.label.width <= 0 || matched.label.height <= 0) return null

  return {
    x: Math.round(matched.label.x + matched.label.width / 2),
    y: Math.round(matched.label.y + matched.label.height / 2),
  }
}

/** 给一个候选标签打分，判断它是不是同一个元素。 */
function scoreElementLabel(
  label: BrowserScreenshotElementLabel,
  target: BrowserElementTargetHint
): Nullable<number> {
  let identityScore = 0
  let contextScore = 0
  const css = target.css?.trim()
  const labelSelector = label.selector?.trim()
  const exactSelector = !!css && !!labelSelector && labelSelector === css
  if (exactSelector) identityScore += 30

  const stableAttributeScore = scoreStableLabelSelector(labelSelector, target.attributes)
  if (!exactSelector && hasStableTargetAttribute(target.attributes) && stableAttributeScore === 0)
    return null
  identityScore += stableAttributeScore

  const targetText = normalizeMatchText(target.text)
  const labelText = normalizeMatchText(label.text)
  if (targetText && labelText && targetText === labelText) identityScore += 10

  const targetRole = target.role?.trim().toLowerCase()
  const labelRole = label.role?.trim().toLowerCase()
  if (targetRole && labelRole && targetRole !== labelRole) return null
  if (targetRole && labelRole && targetRole === labelRole) contextScore += 2

  // role 只描述类别，子串文本也不足以证明截图里的元素就是原目标。
  return identityScore >= 10 ? identityScore + contextScore : null
}

/** 给一个稳定属性选择器打分：越能唯一定位分越高。 */
function scoreStableLabelSelector(
  selector: LooseOptional<string>,
  attributes: LooseOptional<BrowserElementTargetHint['attributes']>
): number {
  if (!selector) return 0

  const id = attributes?.id?.trim()
  if (id && selector === `#${id}`) return 24

  for (const key of ['data-testid', 'data-test', 'data-qa'] as const) {
    const value = attributes?.[key]?.trim()
    if (value && selector.includes(`[${key}="${quoteSelectorAttribute(value)}"]`)) return 22
  }

  const name = attributes?.name?.trim()
  if (name && selector.includes(`[name="${quoteSelectorAttribute(name)}"]`)) return 18

  return 0
}

/** 判目标身上有没有稳定的身份属性（id、data-testid 之类）。 */
function hasStableTargetAttribute(
  attributes: LooseOptional<BrowserElementTargetHint['attributes']>
): boolean {
  return ['id', 'data-testid', 'data-test', 'data-qa', 'name'].some(
    (key) => !!attributes?.[key]?.trim()
  )
}

/** 把属性值转义成能安全放进 CSS selector 的形式。 */
function quoteSelectorAttribute(value: string): string {
  return value.replace(/["\\]/gu, '\\$&')
}

/** 从元素矩形算一个可点的中心点；零尺寸或不在视口里就不给。 */
async function findClickPointFromBounds(
  target: BrowserElementTargetHint,
  ctx: BrowserOperationContext
): Promise<Nullable<CoordinateClickPoint>> {
  const css = target.css?.trim()
  if (!css) return null

  const payload = scriptOutcomeValue(
    await ctx.browser.evaluateScript({
      script: [
        '(selector) => {',
        '  const matches = Array.from(document.querySelectorAll(selector))',
        '  if (matches.length !== 1) return { found: false, matchCount: matches.length }',
        '  const r = matches[0].getBoundingClientRect()',
        '  return {',
        '    found: true,',
        '    width: r.width,',
        '    height: r.height,',
        '    centerX: Math.round(r.x + r.width / 2),',
        '    centerY: Math.round(r.y + r.height / 2),',
        '    viewportWidth: window.innerWidth,',
        '    viewportHeight: window.innerHeight,',
        '  }',
        '}',
      ].join('\n'),
      args: [css],
      maxResultChars: BrowserEvaluateLimits.resultChars,
    })
  )

  if (!isPlainObject(payload) || !isTrue(payload.found)) return null

  const width = readFiniteNumber(payload.width)
  const height = readFiniteNumber(payload.height)
  // 零尺寸(display:none、未展开的菜单项、占位元素)的矩形全是 0:它的"中心"就是视口 (0,0),
  // 点下去命中的是页面左上角的任意元素。这种元素判恢复失败,如实回退原始的未命中结果。
  if (!isPresent(width) || !isPresent(height) || width <= 0 || height <= 0) return null

  const centerX = readFiniteNumber(payload.centerX)
  const centerY = readFiniteNumber(payload.centerY)
  if (!isPresent(centerX) || !isPresent(centerY)) return null
  // 中心点落在视口外(元素在折叠区、被滚动出去)时坐标点击同样会点错人,不做恢复。
  if (!isInsideViewport(centerX, centerY, payload)) return null

  return { x: centerX, y: centerY }
}

/** 中心点是否落在当前视口内；页面没给出视口尺寸时只要求坐标非负。 */
function isInsideViewport(x: number, y: number, payload: Record<string, unknown>): boolean {
  if (x < 0 || y < 0) return false

  const viewportWidth = readFiniteNumber(payload.viewportWidth)
  const viewportHeight = readFiniteNumber(payload.viewportHeight)
  if (isPresent(viewportWidth) && viewportWidth > 0 && x >= viewportWidth) return false

  return !(isPresent(viewportHeight) && viewportHeight > 0 && y >= viewportHeight)
}

/** 把用于比对的文本压成单行小写，去掉多余空白。 */
function normalizeMatchText(value: Optional<Nullable<string>>): string {
  return value?.replace(/\s+/gu, ' ').trim().toLowerCase() ?? ''
}

/** 是有限数就原样返回，否则返回 undefined。 */
function readFiniteNumber(value: unknown): Nullable<number> {
  return isFiniteNumber(value) ? value : null
}
