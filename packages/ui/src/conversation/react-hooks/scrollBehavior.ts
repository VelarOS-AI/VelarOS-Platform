/**
 * 会话滚动行为纯策略（自动跟随 / 分节导航 / 滚动恢复）。零耦合叶子,随会话渲染件入包;
 * 宿主通过 `@velaros-ai/ui/conversation` 复用这里的实现，滚动判定只有这一份权威来源。
 */
import { isFiniteNumber } from '#internal/runtime'

export interface SectionMetric {
  top: number
}

export const AutoScrollSuspendEventName = 'velaros:auto-scroll-suspend'

/**
 * 夹底守卫写在滚动容器上的 CSS 自定义属性，值是滚动内容末尾占位元素的高度。
 * `useScrollToBottom` 命令式写入，滚动内容最后一个 aria-hidden 占位元素以 `height: var(...)` 消费。
 */
export const ScrollClampGuardCssVariable = '--velar-scroll-clamp-guard'

/**
 * 占位在「刚好撑住读者位置」之外多留的余量。被撑住的读者因此离（含占位的）底部仍有这段距离，
 * 各处「是否到底」的判定（贴底 2px、近底 24px、导航与窗口 8px）都不会误判为到底而恢复跟随；
 * 读者自己往下滚完这段余量，才算回到底部。
 */
export const ScrollClampGuardSlackPx = 48

const ScrollClampGuardTolerancePx = 1

export function findPreviousSectionTop(
  metrics: SectionMetric[],
  anchorTop: number,
  snapThreshold: number
): number | undefined {
  for (let index = metrics.length - 1; index >= 0; index -= 1) {
    const metric = metrics[index]
    if (metric && metric.top < anchorTop - snapThreshold) return metric.top
  }

  return undefined
}

export function findNextSectionTop(
  metrics: SectionMetric[],
  anchorTop: number,
  snapThreshold: number
): number | undefined {
  for (const metric of metrics) {
    if (metric.top > anchorTop + snapThreshold) return metric.top
  }

  return undefined
}

export interface SectionNavigationTargetTopInput {
  metrics: SectionMetric[]
  currentScrollTop: number
  direction: 'previous' | 'next'
  snapThreshold: number
  maxScrollTop: number
}

export function resolveSectionNavigationTargetTop({
  metrics,
  currentScrollTop,
  direction,
  snapThreshold,
  maxScrollTop,
}: SectionNavigationTargetTopInput): number | undefined {
  const targetTop =
    direction === 'previous'
      ? findPreviousSectionTop(metrics, currentScrollTop, snapThreshold)
      : findNextSectionTop(metrics, currentScrollTop, snapThreshold)

  const finiteTargetTop = targetTop ?? Number.NaN
  if (!Number.isFinite(finiteTargetTop)) return undefined

  return Math.min(Math.max(Math.floor(finiteTargetTop), 0), Math.max(Math.floor(maxScrollTop), 0))
}

export interface AutoScrollPinnedAfterResetInput {
  currentPinned: boolean
  resetKeyChanged: boolean
}

export interface AutoScrollPinnedAfterScrollInput {
  previousPinned: boolean
  previousScrollTop: number
  currentScrollTop: number
  isNearBottom: boolean
  /** 是否贴到「真正的底部」（比 near-bottom 更严格）；决定「已解除跟随」后何时恢复跟随。 */
  isAtBottom?: boolean
  upwardScrollTolerancePx?: number
}

export interface AutoScrollAfterContentResizeInput {
  pinned: boolean
  previousScrollTop?: number
  currentScrollTop?: number
  isNearBottom?: boolean
  movementTolerancePx?: number
}

export interface ImmediateAutoScrollInput {
  pinned: boolean
  previousScrollTop?: number
  currentScrollTop?: number
  isNearBottom?: boolean
  movementTolerancePx?: number
}

export interface ScheduledAutoScrollInput {
  pinned: boolean
  scheduledScrollTop: number
  currentScrollTop: number
  isNearBottom: boolean
  movementTolerancePx?: number
}

export interface RestoredScrollTopInput {
  scrollTop: number
  maxScrollTop: number
}

export interface RestoredScrollTopDecision {
  nextScrollTop: number
  pendingScrollTop: Nullable<number>
  shouldPersist: boolean
}

export interface AutoScrollWheelDecision {
  shouldPreventDefault: boolean
  shouldSuspendAutoScroll: boolean
}

export interface TranscriptWindowFollowEndAfterScrollInput {
  currentFollowEnd: boolean
  previousScrollTop: number
  currentScrollTop: number
  isAtBottom: boolean
  movementTolerancePx?: number
}

export function resolveAutoScrollPinnedAfterReset({
  currentPinned,
  resetKeyChanged,
}: AutoScrollPinnedAfterResetInput): boolean {
  return resetKeyChanged ? true : currentPinned
}

export function shouldSuspendAutoScrollForWheel(deltaY: number): boolean {
  return Number.isFinite(deltaY) && deltaY < 0
}

export function resolveAutoScrollWheelDecision(
  followLocked: boolean,
  deltaY: number
): AutoScrollWheelDecision {
  if (followLocked)
    return {
      shouldPreventDefault: true,
      shouldSuspendAutoScroll: false,
    }

  return {
    shouldPreventDefault: false,
    shouldSuspendAutoScroll: shouldSuspendAutoScrollForWheel(deltaY),
  }
}

export function resolveTranscriptWindowFollowEndAfterScroll({
  currentFollowEnd,
  previousScrollTop,
  currentScrollTop,
  isAtBottom,
  movementTolerancePx = 1,
}: TranscriptWindowFollowEndAfterScrollInput): boolean {
  const tolerance = Math.max(0, movementTolerancePx)
  // 上移后仍贴着底部是内容变短时的夹底（见 resolveAutoScrollPinnedAfterScroll），不是用户上滑。
  if (currentScrollTop < previousScrollTop - tolerance) return currentFollowEnd && isAtBottom

  return !currentFollowEnd && currentScrollTop > previousScrollTop + tolerance && isAtBottom
    ? true
    : currentFollowEnd
}

export function resolveAutoScrollPinnedAfterScroll({
  previousPinned,
  previousScrollTop,
  currentScrollTop,
  isNearBottom,
  isAtBottom,
  upwardScrollTolerancePx = 1,
}: AutoScrollPinnedAfterScrollInput): boolean {
  const isScrollingUp = currentScrollTop < previousScrollTop - upwardScrollTolerancePx

  // 用户上滑：立即解除跟随，哪怕只在 near-bottom 区内小幅上滑。
  // 例外是夹底：内容变短（发送后输入框清空、底部留白收回，卡片收起）时浏览器把 scrollTop 夹到新的
  // 底部，看起来也是「上移」，但仍贴着底部——这不是用户在滚，照旧跟随。用户的滚轮、拖滚动条在
  // scroll 事件之前就经暂停事件解除了跟随，不靠这里判断。
  if (isScrollingUp) return previousPinned && !!isAtBottom

  // 本来就在跟随、且没有上滑：继续跟随（流式贴底的程序滚动也走这条）。
  if (previousPinned) return true

  // 本来「已解除跟随」：只有用户真正回到底部才恢复跟随。
  // 不能用 near-bottom（24px 区）恢复——否则小幅上滑停在该区内会被下一帧重新钉底、把用户拽回底部。
  return isAtBottom ?? isNearBottom
}

// 内容增长/重排只允许容差内的锚定偏移继续跟随；显著向上移动优先解释为用户导航，
// 即使 scroll 事件尚未更新 pinned，也不会被 resize 或下一帧重新拉回底部。
export function shouldAutoScrollAfterContentResize({
  pinned,
  previousScrollTop,
  currentScrollTop,
  isNearBottom,
  movementTolerancePx = 0,
}: AutoScrollAfterContentResizeInput): boolean {
  if (!pinned) return false
  if (isNearBottom) return true
  if (!isFiniteNumber(previousScrollTop) || !isFiniteNumber(currentScrollTop)) return true

  return currentScrollTop >= previousScrollTop - Math.max(0, movementTolerancePx)
}

export function shouldStartImmediateAutoScroll({
  pinned,
  previousScrollTop,
  currentScrollTop,
  isNearBottom,
  movementTolerancePx = 0,
}: ImmediateAutoScrollInput): boolean {
  if (!pinned) return false
  if (isNearBottom) return true
  if (!isFiniteNumber(previousScrollTop) || !isFiniteNumber(currentScrollTop)) return true

  return currentScrollTop >= previousScrollTop - Math.max(0, movementTolerancePx)
}

export function shouldCommitScheduledAutoScroll({
  pinned,
  scheduledScrollTop,
  currentScrollTop,
  isNearBottom,
  movementTolerancePx = 0,
}: ScheduledAutoScrollInput): boolean {
  if (!pinned) return false
  if (isNearBottom) return true

  return currentScrollTop >= scheduledScrollTop - Math.max(0, movementTolerancePx)
}

export function resolveRestoredScrollTop({
  scrollTop,
  maxScrollTop,
}: RestoredScrollTopInput): RestoredScrollTopDecision {
  const normalizedScrollTop = Math.max(0, Math.floor(scrollTop))
  const normalizedMaxScrollTop = Math.max(0, Math.floor(maxScrollTop))
  const isPending = normalizedScrollTop > normalizedMaxScrollTop

  return {
    nextScrollTop: Math.min(normalizedScrollTop, normalizedMaxScrollTop),
    pendingScrollTop: isPending ? normalizedScrollTop : null,
    shouldPersist: !isPending,
  }
}

export interface AutoCollapseHoldState {
  collapseRequested: boolean
  /** true = 这次收起请求被扣下，保持展开。 */
  holdExpanded: boolean
}

/**
 * 界面自发的收起请求（流式结束的完成态重排、计时到点的卡片折叠）要不要扣下。
 *
 * 只在请求「出现」的那一刻问一次读者是否在跟随底部，不在就扣下并记住；挂载时就已处于请求态
 * （历史消息、切回来的会话）不算出现，照原样收起；请求撤回即解除。状态不变时原样返回同一个对象。
 */
export function resolveAutoCollapseHold(
  current: AutoCollapseHoldState,
  collapseRequested: boolean,
  isFollowingBottom: () => boolean
): AutoCollapseHoldState {
  if (current.collapseRequested === collapseRequested) return current

  return {
    collapseRequested,
    holdExpanded: collapseRequested && !isFollowingBottom(),
  }
}

/** 占位高度的这次更新从哪来：内容/视口尺寸变化可以加高占位，读者自己滚动只许缩小。 */
export type ScrollClampGuardCause = 'content-resize' | 'reader-scroll'

export interface ScrollClampGuardInput {
  /** 读者正在跟随底部（含持续跟随）：守卫一律清零，位置交给贴底逻辑。 */
  following: boolean
  cause: ScrollClampGuardCause
  /** 当前已生效的占位高度。 */
  guardPx: number
  /** 这次变化之前读者停留的位置（浏览器夹底之前的 scrollTop）。 */
  previousScrollTop: number
  currentScrollTop: number
  /** 含占位在内的最大滚动距离（scrollHeight - clientHeight）。 */
  maxScrollTop: number
  viewportHeight: number
}

export interface ScrollClampGuardDecision {
  guardPx: number
  /** 浏览器已把视口夹到新底部时要放回的位置；null 表示不必动 scrollTop。 */
  restoreScrollTop: Nullable<number>
}

const ReleasedScrollClampGuard: ScrollClampGuardDecision = { guardPx: 0, restoreScrollTop: null }

/** 读者停在 readerScrollTop 时需要多高的占位：超出自然底部的部分加余量，没超出就不需要。 */
function resolveHoldingGuardPx(readerScrollTop: number, naturalMaxScrollTop: number): number {
  const overshoot = readerScrollTop - naturalMaxScrollTop
  return overshoot > ScrollClampGuardTolerancePx
    ? Math.ceil(overshoot) + ScrollClampGuardSlackPx
    : 0
}

/**
 * 夹底守卫：读者已解除跟随时，视口里的内容变矮会让浏览器把 scrollTop 夹到新的底部，读者正在看的
 * 内容被整体下推。这里算出末尾占位要多高、以及要不要把视口放回原位，保证界面自己的变化不挪动读者。
 *
 * - 夹底的判据是「原位置已超出新范围，且视口正停在新底部」。原生滚动锚定挪过的位置不会停在底部，
 *   照原样尊重，不当成夹底。
 * - 读者看的内容已整屏消失（要撑的高度达到一屏）时放弃：撑住只剩一屏空白，不如交给浏览器夹底。
 * - 读者上滑或内容重新长高时占位随之缩小；读者往下滚不会把占位加高，滚完余量即回到底部。
 */
export function resolveScrollClampGuard({
  following,
  cause,
  guardPx,
  previousScrollTop,
  currentScrollTop,
  maxScrollTop,
  viewportHeight,
}: ScrollClampGuardInput): ScrollClampGuardDecision {
  if (following) return ReleasedScrollClampGuard

  const naturalMaxScrollTop = Math.max(0, maxScrollTop - guardPx)
  if (cause === 'reader-scroll')
    return {
      guardPx: Math.min(guardPx, resolveHoldingGuardPx(currentScrollTop, naturalMaxScrollTop)),
      restoreScrollTop: null,
    }

  const wasClamped =
    previousScrollTop > maxScrollTop + ScrollClampGuardTolerancePx &&
    currentScrollTop >= maxScrollTop - ScrollClampGuardTolerancePx
  const readerScrollTop = wasClamped ? previousScrollTop : currentScrollTop
  if (readerScrollTop - naturalMaxScrollTop >= viewportHeight) return ReleasedScrollClampGuard

  const nextGuardPx = resolveHoldingGuardPx(readerScrollTop, naturalMaxScrollTop)
  return {
    guardPx: nextGuardPx,
    restoreScrollTop: wasClamped && nextGuardPx > 0 ? readerScrollTop : null,
  }
}
