/**
 * 会话滚动行为纯策略（自动跟随 / 分节导航 / 滚动恢复）。零耦合叶子,随会话渲染件入包;
 * 宿主通过 `@velaros-ai/ui/conversation` 复用这里的实现，滚动判定只有这一份权威来源。
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
