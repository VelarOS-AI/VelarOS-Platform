/**
 * 流式起搏预算（纯函数，无副作用、无环境全局，便于单测）。
 *
 * 设计目标：
 *  - 稳定：字符预算按真实经过时间累计，不再与显示器刷新率绑定。
 *  - 平滑：积压只提高每秒速率，不直接放大单帧吐字量。
 *  - 抗卡顿：长帧只按 `maxFrameIntervalMs` 计时，恢复后不会一次补吐整段。
 *  - 单结构更新：结构事件固定每帧一个，避免多个工具卡同帧更新造成卡顿。
 */

export interface StreamPaceBacklog {
  /** 尚未吐出的文本/思考字符数。 */
  backlogChars: number
  /** 尚未应用的离散结构事件数。 */
  backlogEvents: number
}

export interface StreamPaceBudget {
  /** 本帧最多吐出的字符数。 */
  charBudget: number
  /** 本帧最多应用的结构事件数。 */
  eventBudget: number
  /** 本帧计算完成、尚未消费的字符额度。实际吐字后由起搏器扣减。 */
  availableCharCredit: number
}

export interface StreamPaceTuning {
  /** 无明显积压时的目标字符速率。 */
  baseCharsPerSecond: number
  /** 每个积压字符为目标速率增加的字符/秒；最终仍受 maxCharsPerSecond 限制。 */
  backlogCharsPerSecondGain: number
  /** 有积压时允许的最高字符速率。 */
  maxCharsPerSecond: number
  /** 单帧硬上限；主线程从卡顿中恢复也不能超过它。 */
  maxCharsPerFrame: number
  /** 单帧最多计入多少经过时间，避免长帧累积巨额额度。 */
  maxFrameIntervalMs: number
  /** 没有上一帧时间戳时使用的名义帧间隔。 */
  nominalFrameIntervalMs: number
  baseEvents: number
}

/** 默认起搏参数；可在起搏器构造时覆盖，落地后按手感调。 */
export const DefaultStreamPaceTuning: StreamPaceTuning = {
  // 96 chars/s 约等于 60Hz 下每帧 1～2 字；积压很大时平滑抬到 180 chars/s，
  // 但任何一帧最多 6 字。这样既不会慢吞吞追尾，也不会突然冒出一整段。
  baseCharsPerSecond: 96,
  backlogCharsPerSecondGain: 0.08,
  maxCharsPerSecond: 180,
  maxCharsPerFrame: 6,
  maxFrameIntervalMs: 34,
  nominalFrameIntervalMs: 1000 / 60,
  baseEvents: 1,
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function normalizeFinite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

export interface ResolveStreamPaceBudgetOptions {
  /** 当前帧距上一帧的真实时间。 */
  elapsedMs?: number
  /** 上一帧剩余的不足一字额度。 */
  carriedCharCredit?: number
}

export function resolveStreamPaceBudget(
  backlog: StreamPaceBacklog,
  tuning: StreamPaceTuning = DefaultStreamPaceTuning,
  options: ResolveStreamPaceBudgetOptions = {}
): StreamPaceBudget {
  const backlogChars = Math.max(0, Math.floor(normalizeFinite(backlog.backlogChars, 0)))
  const eventBudget = Math.max(1, Math.floor(normalizeFinite(tuning.baseEvents, 1)))

  if (backlogChars === 0)
    return {
      charBudget: 0,
      eventBudget,
      availableCharCredit: 0,
    }

  const baseRate = Math.max(1, normalizeFinite(tuning.baseCharsPerSecond, 1))
  const maxRate = Math.max(baseRate, normalizeFinite(tuning.maxCharsPerSecond, baseRate))
  const backlogGain = Math.max(0, normalizeFinite(tuning.backlogCharsPerSecondGain, 0))
  const charsPerSecond = clamp(baseRate + backlogChars * backlogGain, baseRate, maxRate)
  const maxCharsPerFrame = Math.max(1, Math.floor(normalizeFinite(tuning.maxCharsPerFrame, 1)))
  const nominalFrameIntervalMs = Math.max(
    0,
    normalizeFinite(tuning.nominalFrameIntervalMs, 1000 / 60)
  )
  const maxFrameIntervalMs = Math.max(
    nominalFrameIntervalMs,
    normalizeFinite(tuning.maxFrameIntervalMs, nominalFrameIntervalMs)
  )
  const elapsedMs = clamp(
    normalizeFinite(options.elapsedMs ?? nominalFrameIntervalMs, nominalFrameIntervalMs),
    0,
    maxFrameIntervalMs
  )
  const carriedCharCredit = clamp(
    normalizeFinite(options.carriedCharCredit ?? 0, 0),
    0,
    maxCharsPerFrame
  )
  const availableCharCredit = clamp(
    carriedCharCredit + (charsPerSecond * elapsedMs) / 1000,
    0,
    maxCharsPerFrame
  )

  return {
    charBudget: Math.min(backlogChars, Math.floor(availableCharCredit), maxCharsPerFrame),
    eventBudget,
    availableCharCredit,
  }
}
