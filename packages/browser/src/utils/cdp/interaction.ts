/** CDP 交互引擎里用不着实例状态的那部分：动作入参与回执的归一。 */

import { isArray, isBoolean, isEmpty, isFiniteNumber, isNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { BrowserPageDriver } from '../../contract/requires.js'
import type { BrowserTargetActionEffect } from '../../types/browser.js'
import type { BrowserElementTargetHint, BrowserPageZoomOptions, BrowserTargetActionTextDiff } from '../../types/browser.js'
import type { BrowserTargetActionEffectSnapshot, BrowserTargetActionOptions } from '../../types/browser.js'
import type { BrowserPointerPoint, BrowserTargetActionClickMode, BrowserTargetActionInternalEffectSnapshot } from '../../types/runtime.js'
import { clampZoomFactor } from '../numbers.js'
import { clampInteger } from '../numbers.js'
import { BrowserTuning } from '../tuning'

/** 目标元素的匹配文本归一：去空白、转小写。 */
export function normalizeTargetMatchText(value: LooseOptional<string>): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 目标元素的身份字段归一，用来判断前后是不是同一个元素。 */
export function normalizeTargetIdentityValue(value: LooseOptional<string>): string {
  return String(value ?? '').trim()
}

/** 页面脚本给的动作效果指纹归一；形状不对就当没有。 */
export function normalizeTargetActionEffectSnapshot(
  value: unknown
): Nullable<BrowserTargetActionInternalEffectSnapshot> {
  if (!isPlainObject(value)) return null
  if (!isString(value.url)) return null
  if (!isString(value.title)) return null
  if (!isString(value.textHash)) return null
  if (!isNumber(value.textLength)) return null
  const textSampleLines = isArray(value.textSampleLines)
    ? value.textSampleLines.filter(isString).slice(0, BrowserTuning.page.actionEffectSampleLines)
    : []

  return {
    url: value.url,
    title: value.title,
    textHash: value.textHash,
    textLength: Math.max(0, Math.round(value.textLength)),
    textSampleLines,
    textSampleTruncated: isBoolean(value.textSampleTruncated) ? value.textSampleTruncated : false,
  }
}

/** 把内部的效果指纹收窄成回执里给模型看的那几项。 */
export function toPublicTargetActionEffectSnapshot(
  snapshot: BrowserTargetActionInternalEffectSnapshot
): BrowserTargetActionEffectSnapshot {
  return {
    url: snapshot.url,
    title: snapshot.title,
    textHash: snapshot.textHash,
    textLength: snapshot.textLength,
  }
}

/** 算两段文本行的最长公共子序列长度，用来判动作前后页面变了多少。 */
export function countLongestCommonSubsequence(before: string[], after: string[]): number {
  if (isEmpty(before) || isEmpty(after)) return 0

  let previous = Array.from({ length: after.length + 1 }, () => 0)
  for (const beforeLine of before) {
    const current = Array.from({ length: after.length + 1 }, () => 0)
    after.forEach((afterLine, afterIndex) => {
      current[afterIndex + 1] = beforeLine === afterLine
        ? previous[afterIndex] + 1
        : Math.max(previous[afterIndex + 1], current[afterIndex])
    })
    previous = current
  }

  return previous[after.length] ?? 0
}

/** 判断这次点击走 DOM 点击还是坐标点击。 */
export function resolveTargetActionClickMode(
  driver: BrowserPageDriver,
  options: BrowserTargetActionOptions
): BrowserTargetActionClickMode {
  if (options.action !== 'click') return 'dom'
  if (!driver.clickCoordinates) return 'dom'

  return 'coordinate'
}

/** 读一个指针坐标并取整；不是有限数就当没有。 */
export function readBrowserPointerPoint(
  value: Optional<Nullable<{ x: number; y: number }>>
): Nullable<{ x: number; y: number }> {
  if (!value) return null
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null

  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
  }
}

/** 把坐标夹进外部浏览器视口的合法范围。 */
export function clampExternalViewportPoint(x: number, y: number): BrowserPointerPoint {
  return {
    x: clampInteger(x, 0, 32_000, 0),
    y: clampInteger(y, 0, 32_000, 0),
  }
}

/** 缩放步长与 `clampZoomFactor` 同形不同界（步长 0.05–0.5，因子 0.25–3），刻意各自成立。 */
export function clampZoomStep(value: LooseOptional<number>, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback

  const normalized = Math.round(value * 100) / 100
  return Math.min(Math.max(normalized, 0.05), 0.5)
}

/** 判断自愈时新旧目标是不是在同一个 frame 上下文里。 */
export function isSelfHealingFrameCompatible(
  staleTarget: BrowserElementTargetHint,
  freshTarget: BrowserElementTargetHint
): boolean {
  if (!staleTarget.frame && !freshTarget.frame) return true
  if (!staleTarget.frame || !freshTarget.frame) return false

  let matched = false
  for (const key of ['css', 'url'] as const) {
    const staleValue = normalizeTargetIdentityValue(staleTarget.frame[key])
    const freshValue = normalizeTargetIdentityValue(freshTarget.frame[key])
    if (staleValue && staleValue !== freshValue) return false
    if (staleValue) matched = true
  }
  for (const key of ['name', 'title'] as const) {
    const staleValue = normalizeTargetMatchText(staleTarget.frame[key])
    const freshValue = normalizeTargetMatchText(freshTarget.frame[key])
    if (staleValue && staleValue !== freshValue) return false
    if (staleValue) matched = true
  }
  return matched
}

/** 比动作前后的正文采样，给出增删了多少行。 */
export function diffTargetActionTextSamples(
  before: BrowserTargetActionInternalEffectSnapshot,
  after: BrowserTargetActionInternalEffectSnapshot
): BrowserTargetActionTextDiff {
  const unchanged = countLongestCommonSubsequence(
    before.textSampleLines,
    after.textSampleLines
  )
  const additions = Math.max(0, after.textSampleLines.length - unchanged)
  const removals = Math.max(0, before.textSampleLines.length - unchanged)

  return {
    changed: additions > 0 || removals > 0,
    additions,
    removals,
    unchanged,
    truncated: before.textSampleTruncated || after.textSampleTruncated,
  }
}


/** 按缩放动作算出新的缩放比例，并夹进合法区间。 */
export function resolvePageZoomFactor(
  options: BrowserPageZoomOptions,
  currentZoomFactor: number
): number {
  const step = clampZoomStep(options.step, 0.1)

  switch (options.action) {
    case 'in':
      return clampZoomFactor(currentZoomFactor + step, 1)
    case 'out':
      return clampZoomFactor(currentZoomFactor - step, 1)
    case 'reset':
      return 1
    case 'set':
      return clampZoomFactor(options.zoomFactor, 1)
    default:
      return currentZoomFactor
  }
}

/**
 * 自愈时「稳定属性」各自的权重：这是规则本身的数据，跟着判定放。
 *
 * 越靠上的属性越能证明「还是同一个元素」；旧观察声明过的稳定属性一旦对不上就直接否掉，
 * 不靠同名文本把动作落到另一个元素上。
 */
const BrowserSelfHealingStableAttributeWeights: Readonly<Record<string, number>> = {
  id: 12,
  'data-testid': 12,
  'data-test': 12,
  'data-qa': 12,
  controlId: 12,
  href: 10,
  'aria-labelledby': 10,
  'aria-label': 9,
  name: 9,
  title: 8,
  placeholder: 8,
}

/** 给「新候选是不是原来那个元素」打分；稳定属性对不上直接否掉。 */
export function scoreSelfHealingTarget(
  staleTarget: BrowserElementTargetHint,
  freshTarget: BrowserElementTargetHint
): Nullable<{ identityScore: number; totalScore: number }> {
  if (!isSelfHealingFrameCompatible(staleTarget, freshTarget)) return null

  let identityScore = 0
  let contextScore = 0
  const staleRole = normalizeTargetMatchText(staleTarget.role)
  const freshRole = normalizeTargetMatchText(freshTarget.role)
  const staleText = normalizeTargetMatchText(staleTarget.text)
  const freshText = normalizeTargetMatchText(freshTarget.text)
  const staleName = normalizeTargetMatchText(staleTarget.name)
  const freshName = normalizeTargetMatchText(freshTarget.name)

  if (staleRole && freshRole && staleRole !== freshRole) return null
  if (staleRole && freshRole && staleRole === freshRole) contextScore += 2
  if (staleText && freshText && staleText === freshText) identityScore += 8
  if (staleName && freshName && staleName !== freshName) return null
  if (staleName && freshName && staleName === freshName) identityScore += 9

  for (const [key, weight] of Object.entries(BrowserSelfHealingStableAttributeWeights)) {
    const value = staleTarget.attributes?.[key]
    const staleValue = normalizeTargetIdentityValue(value)
    const freshValue = normalizeTargetIdentityValue(freshTarget.attributes?.[key])
    // stable attribute 一旦由旧 observation 声明，就是身份约束而不是可选加分项。
    // 新候选缺字段和字段冲突同样拒绝，不能再靠同名文本误点另一个元素。
    if (staleValue && staleValue !== freshValue) return null
    if (staleValue) identityScore += weight
  }

  // role、动作类型或候选所在列表只描述类别，不足以证明元素身份。
  if (identityScore < 8) return null

  return {
    identityScore,
    totalScore: identityScore + contextScore,
  }
}

/** 按动作前后的两份指纹拼出「这次动作有没有让页面真的变了」。 */
export function buildTargetActionEffect(
  before: Nullable<BrowserTargetActionInternalEffectSnapshot>,
  after: Nullable<BrowserTargetActionInternalEffectSnapshot>
): Nullable<BrowserTargetActionEffect> {
  if (!before || !after) return null

  const textDiff = diffTargetActionTextSamples(before, after)

  return {
    observed: true,
    urlChanged: before.url !== after.url,
    titleChanged: before.title !== after.title,
    textChanged: before.textHash !== after.textHash || before.textLength !== after.textLength,
    textDiff,
    before: toPublicTargetActionEffectSnapshot(before),
    after: toPublicTargetActionEffectSnapshot(after),
  }
}
