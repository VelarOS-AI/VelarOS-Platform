import { ContextLimits } from '../contract/constants.js'
import type { ContextHourlyUsage } from '../types/context.js'

/** 把按小时分桶的预留量滚到 now 所在的桶：跨过一个桶，当前桶变成上一桶；跨过两个以上，两桶都清零。 */
export function rolledHourly(
  hourly: Optional<ContextHourlyUsage>,
  now: number
): ContextHourlyUsage {
  if (!hourly) return { start: now, tokens: 0, previous: 0 }
  const passed = Math.floor((now - hourly.start) / ContextLimits.hourlyWindowMs)
  if (passed <= 0) return hourly
  return {
    start: hourly.start + passed * ContextLimits.hourlyWindowMs,
    tokens: 0,
    previous: passed === 1 ? hourly.tokens : 0,
  }
}

/** 最近一小时的用量：当前桶全额，加上一桶按这一小时还没过去的比例折算。 */
export function recentHourlyTokens(hourly: ContextHourlyUsage, now: number): number {
  return (
    hourly.tokens +
    Math.ceil(
      hourly.previous * Math.max(0, 1 - (now - hourly.start) / ContextLimits.hourlyWindowMs)
    )
  )
}

/** 还要等多久才能再预留 tokens：当前桶已经不够就等到下一桶；否则等上一桶淡出到够用。 */
export function hourlyRetryMs(
  hourly: ContextHourlyUsage,
  tokens: number,
  limit: number,
  now: number
): number {
  if (hourly.tokens + tokens > limit || hourly.previous <= 0)
    return Math.max(1, hourly.start + ContextLimits.hourlyWindowMs - now)
  const elapsed = 1 - (limit - hourly.tokens - tokens) / hourly.previous
  return Math.max(1, Math.ceil(hourly.start + elapsed * ContextLimits.hourlyWindowMs - now))
}
