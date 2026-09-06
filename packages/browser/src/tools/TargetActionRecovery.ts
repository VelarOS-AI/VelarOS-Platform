import {
  isFiniteNumber,
  isNull,
  isPlainObject,
  isPresent,
  isTrue,
} from '@velaros-ai/core'

import type { BrowserElementTargetHint, BrowserScreenshotElementLabel, BrowserTargetActionOptions, BrowserTargetActionResult } from '../core'
import { buildBrowserScreenshotOptions } from '../core'

import type { ToolContext } from './Types'

interface CoordinateClickPoint {
  x: number
  y: number
}

interface TargetActionEffectRecovery {
  source: 'target-action-effect'
  reason: 'no-observable-change'
  recommendedNextActions: Array<'inspect_page' | 'observe_actions'>
}

/**
 * selector 未命中时，尝试通过截图标注或 bounds 查询做坐标点击恢复。
 *
 * 坐标恢复的全仓唯一实现(战役四:增强层第二份同构恢复已删,那边只剩 blocker/effect
 * 纯注解)。历史教训:双份曾双向漂移(covered 短路/异常降级/abort 检查各修一边)——
 * 别再在别处复制本逻辑。
 */
export async function performTargetActionWithRecovery(
  action: BrowserTargetActionOptions,
  ctx: ToolContext
): Promise<
  BrowserTargetActionResult & {
    selectorRecovery?: Record<string, unknown>
    actionEffect?: TargetActionEffectRecovery
  }
> {
  const result = await ctx.browser.performTargetAction(action)
  const actionEffect = buildTargetActionEffectRecovery(action, result)
  if (result.matched || action.action !== 'click') return actionEffect ? { ...result, actionEffect } : result

  // 被遮挡的元素不做坐标恢复:对同一中心点再点一次只会点中遮挡层,
  // 且误标 matched:true 会让增强层的 covered 指引(targetBlocker)整条失效。
  if (result.failureReason === 'covered') return result

  try {
    const recovery = await tryCoordinateRecovery(action.target, ctx)
    if (!recovery) return result

    return {
      ...result,
      matched: true,
      selectorRecovery: recovery,
    }
  } catch (error) {
    // 恢复本身失败(页面跳走/target 销毁等)不升级为工具错误:
    // 手里已有结构化 miss 结果与 nextActions 指引,退回它;用户中止照常外抛。
    if (ctx.abortSignal.aborted) throw error
    return result
  }
}

function buildTargetActionEffectRecovery(
  action: BrowserTargetActionOptions,
  result: BrowserTargetActionResult
): Nullable<TargetActionEffectRecovery> {
  const effect = result.effect
  if (action.action !== 'click') return null
  if (!result.matched || !effect?.observed) return null
  if (effect.urlChanged || effect.titleChanged || effect.textChanged) return null

  return {
    source: 'target-action-effect',
    reason: 'no-observable-change',
    recommendedNextActions: ['inspect_page', 'observe_actions'],
  }
}

async function tryCoordinateRecovery(
  target: BrowserElementTargetHint,
  ctx: ToolContext
): Promise<Nullable<Record<string, unknown>>> {
  ctx.abortSignal.throwIfAborted()

  const screenshot = await ctx.browser.captureScreenshot(
    buildBrowserScreenshotOptions({
      path: `artifacts/screenshots/recovery/target-action-${Date.now()}.png`,
      modelFacing: true,
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

  return {
    x: Math.round(matched.label.x + matched.label.width / 2),
    y: Math.round(matched.label.y + matched.label.height / 2),
  }
}

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

function hasStableTargetAttribute(
  attributes: LooseOptional<BrowserElementTargetHint['attributes']>
): boolean {
  return ['id', 'data-testid', 'data-test', 'data-qa', 'name'].some((key) =>
    !!attributes?.[key]?.trim()
  )
}

function quoteSelectorAttribute(value: string): string {
  return value.replace(/["\\]/gu, '\\$&')
}

async function findClickPointFromBounds(
  target: BrowserElementTargetHint,
  ctx: ToolContext
): Promise<Nullable<CoordinateClickPoint>> {
  const css = target.css?.trim()
  if (!css) return null

  const selectorLiteral = JSON.stringify(css)
  const bounds = await ctx.browser.evaluateScript({
    script: [
      `const matches = Array.from(document.querySelectorAll(${selectorLiteral}));`,
      `if (matches.length !== 1) return { found: false, matchCount: matches.length };`,
      `const el = matches[0];`,
      'const r = el.getBoundingClientRect();',
      'return {',
      '  found: true,',
      '  centerX: Math.round(r.x + r.width / 2),',
      '  centerY: Math.round(r.y + r.height / 2),',
      '};',
    ].join('\n'),
    mode: 'function-body',
  })

  // evaluateScript 恒返回 BrowserEvaluateScriptResult 信封(engine 在页面内构造),载荷只在 .result。
  const payload = bounds.result
  if (!isPlainObject(payload) || !isTrue(payload.found)) return null

  const centerX = readFiniteNumber(payload.centerX)
  const centerY = readFiniteNumber(payload.centerY)
  if (!isPresent(centerX) || !isPresent(centerY)) return null

  return { x: centerX, y: centerY }
}

function normalizeMatchText(value: Optional<Nullable<string>>): string {
  return value?.replace(/\s+/gu, ' ').trim().toLowerCase() ?? ''
}

function readFiniteNumber(value: unknown): Nullable<number> {
  return isFiniteNumber(value) ? value : null
}
