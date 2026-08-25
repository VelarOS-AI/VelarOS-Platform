/**
 * 会话滚动行为纯策略（自动跟随 / 分节导航 / 滚动恢复）。零耦合叶子,随会话渲染件入包;
 * 宿主 `@utils/dom/scrollBehavior.utils` 另有同源副本(pass-4 shell 迁移后统一)。
 */
import { isFiniteNumber } from '#internal/runtime'

export interface SectionMetric {
  top: number
}

export const AutoScrollSuspendEventName = 'velaros:auto-scroll-suspend'

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
  if (isScrollingUp) return false

  // 本来就在跟随、且没有上滑：继续跟随（流式贴底的程序滚动也走这条）。
  if (previousPinned) return true

  // 本来「已解除跟随」：只有用户真正回到底部才恢复跟随。
  // 不能用 near-bottom（24px 区）恢复——否则小幅上滑停在该区内会被下一帧重新钉底、把用户拽回底部。
  return isAtBottom ?? isNearBottom
}

// 内容增长/重排（流式吐字、工具卡插入、活动组折叠）引起的 scrollTop 变化是内容驱动的，
// 不是用户意图——浏览器的滚动锚定不会派发 scroll 事件，所以「是否跟随」只由 scroll 事件
// (resolveAutoScrollPinnedAfterScroll) 决定。这里只要仍在跟随就贴底，绝不因内容重排把
// scrollTop 上移误判成「用户上滑」而停跟随（那正是「工具卡插入后不再自动跟随」的根因）。
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
