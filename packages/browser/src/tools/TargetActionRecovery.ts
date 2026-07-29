import {
  isFiniteNumber,
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
  const matched = labels.find((label) => matchesElementLabel(label, target))
  if (!matched) return null

  return {
    x: Math.round(matched.x + matched.width / 2),
    y: Math.round(matched.y + matched.height / 2),
  }
}

function matchesElementLabel(
  label: BrowserScreenshotElementLabel,
  target: BrowserElementTargetHint
): boolean {
  const css = target.css?.trim()
  if (css && label.selector && (label.selector === css || css.includes(label.selector))) return true

  const testId = target.attributes?.['data-testid'] ?? target.attributes?.['data-test']
  if (testId && label.selector?.includes(`data-testid="${testId}"`)) return true

  const targetText = normalizeMatchText(target.text)
  const labelText = normalizeMatchText(label.text)
  if (targetText && labelText && (labelText.includes(targetText) || targetText.includes(labelText))) return true

  const targetRole = target.role?.trim().toLowerCase()
  const labelRole = label.role?.trim().toLowerCase()

  return !!(
    targetRole &&
    labelRole &&
    targetRole === labelRole &&
    (!targetText || labelText.includes(targetText))
  )
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
      `const el = document.querySelector(${selectorLiteral});`,
      `if (!el) return { found: false };`,
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

function normalizeMatchText(value: Nullable<string> | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function readFiniteNumber(value: unknown): Nullable<number> {
  return isFiniteNumber(value) ? value : null
}
