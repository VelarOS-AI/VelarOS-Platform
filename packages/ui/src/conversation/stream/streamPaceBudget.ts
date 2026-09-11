/**
 * 流式起搏预算（纯函数，无副作用、无环境全局，便于单测）。
 *
 * 吐字速度是一个带惯性的量，而不是积压的瞬时函数：
 *  - 平时：积压在「从容区」以内（约半秒多的字）时按基础速度稳稳地打，网络抖动不带动速度忽快忽慢。
 *  - 积压变多：目标速度按「超出从容区的字在一个追赶窗口内追平」抬高；实际速度用临界阻尼弹簧去追——
 *    从零加速度起步、接近目标时收住，速度与加速度都连续，一帧里不会突然变快。
 *  - 积压消化：目标随积压回落，实际速度同样平滑地降回基础速度；收尾时最后几句仍是平时的节奏。
 *  - 稳定：额度按真实经过时间累计，与刷新率无关；长帧只按 `maxFrameIntervalMs` 计时，单帧有硬上限，
 *    主线程卡顿恢复后不会一次补吐一大段。
 *  - 单结构更新：结构事件固定每帧一个，避免多个工具卡同帧更新造成卡顿。
 */

export interface StreamPaceBacklog {
  /** 尚未吐出的文本/思考字符数。 */
  backlogChars: number
  /** 尚未应用的离散结构事件数。 */
  backlogEvents: number
}

/** 吐字速度的状态；起搏器按会话存下，下一帧原样传回。 */
export interface StreamPaceMotion {
  /** 当前吐字速度（字符/秒）。 */
  charsPerSecond: number
  /** 速度的变化率（字符/秒²），弹簧的内部状态。 */
  acceleration: number
}

export interface StreamPaceBudget {
  /** 本帧最多吐出的字符数。 */
  charBudget: number
  /** 本帧最多应用的结构事件数。 */
  eventBudget: number
  /** 本帧计算完成、尚未消费的字符额度。实际吐字后由起搏器扣减。 */
  availableCharCredit: number
  /** 本帧之后的速度状态。 */
  motion: StreamPaceMotion
}

export interface StreamPaceTuning {
  /** 平时的吐字速度（字符/秒）；积压在从容区内时保持这个速度，空闲后也从它重新起步。 */
  baseCharsPerSecond: number
  /** 从容区：积压不超过「基础速度 × 这么多秒」的字时不提速。 */
  comfortLagSeconds: number
  /** 超出从容区的积压打算在这么多秒内追平：目标速度 = 基础速度 + 超出的字数 / 追赶窗口。 */
  catchUpWindowSeconds: number
  /** 追赶时的最高速度。 */
  maxCharsPerSecond: number
  /** 速度追目标的平滑时间（秒）：越大，加速、减速越缓。 */
  rateSmoothingSeconds: number
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
  // 96 chars/s 约等于 60Hz 下每帧 1～2 字，是平时的节奏；积压超出约 58 字后开始提速，
  // 持续高速输出时画面大约落后一秒出头，积压很大时最快 720 chars/s 追平。
  baseCharsPerSecond: 96,
  comfortLagSeconds: 0.6,
  catchUpWindowSeconds: 0.9,
  maxCharsPerSecond: 720,
  rateSmoothingSeconds: 0.4,
  // 720 chars/s 在 30Hz 帧上约 24 字/帧；再多的只能等下一帧。
  maxCharsPerFrame: 24,
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

function resolveRateBounds(tuning: StreamPaceTuning): { base: number; max: number } {
  const base = Math.max(1, normalizeFinite(tuning.baseCharsPerSecond, 1))
  return { base, max: Math.max(base, normalizeFinite(tuning.maxCharsPerSecond, base)) }
}

/** 静止在基础速度上的速度状态：会话第一次吐字、空闲之后都从这里起步。 */
export function createStreamPaceMotion(
  tuning: StreamPaceTuning = DefaultStreamPaceTuning
): StreamPaceMotion {
  return { charsPerSecond: resolveRateBounds(tuning).base, acceleration: 0 }
}

function resolveRateSmoothingSeconds(tuning: StreamPaceTuning): number {
  return Math.max(0.01, normalizeFinite(tuning.rateSmoothingSeconds, 0.4))
}

/**
 * 按积压算出的目标速度：从容区内是基础速度，超出部分按追赶窗口折成速度，封顶最高速度。
 *
 * 实际速度追目标总有约一个平滑时间的滞后。积压见底时若不提前收，速度还没降下来字就吐完了，
 * 结尾是「高速戛然而止」；所以先扣掉「按当前速度在这段滞后里还会吐掉的字」，让速度在最后几句
 * 之前回到平时的节奏。
 */
export function resolveStreamPaceTargetRate(
  backlogChars: number,
  tuning: StreamPaceTuning = DefaultStreamPaceTuning,
  currentCharsPerSecond?: number
): number {
  const { base, max } = resolveRateBounds(tuning)
  const comfortChars = base * Math.max(0, normalizeFinite(tuning.comfortLagSeconds, 0))
  const catchUpWindow = Math.max(0.05, normalizeFinite(tuning.catchUpWindowSeconds, 1))
  const currentRate = clamp(normalizeFinite(currentCharsPerSecond ?? base, base), base, max)
  const lookaheadChars = currentRate * resolveRateSmoothingSeconds(tuning)
  const excessChars = Math.max(
    0,
    normalizeFinite(backlogChars, 0) - lookaheadChars - comfortChars
  )
  return clamp(base + excessChars / catchUpWindow, base, max)
}

/**
 * 让速度朝目标走一步：临界阻尼弹簧（与 Unity `SmoothDamp` 同一近似），对任意步长都稳定。
 * 目标跳变时速度连续、加速度从零起步；逼近目标时减速收住，不冲过头。
 */
export function advanceStreamPaceMotion(
  motion: StreamPaceMotion,
  targetRate: number,
  elapsedSeconds: number,
  tuning: StreamPaceTuning = DefaultStreamPaceTuning
): StreamPaceMotion {
  const { base, max } = resolveRateBounds(tuning)
  const current = clamp(normalizeFinite(motion.charsPerSecond, base), base, max)
  const velocity = normalizeFinite(motion.acceleration, 0)
  const target = clamp(normalizeFinite(targetRate, base), base, max)
  const dt = Math.max(0, normalizeFinite(elapsedSeconds, 0))
  if (dt === 0) return { charsPerSecond: current, acceleration: velocity }

  const omega = 2 / resolveRateSmoothingSeconds(tuning)
  const x = omega * dt
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const offset = current - target
  const impulse = (velocity + omega * offset) * dt
  let nextRate = target + (offset + impulse) * decay
  let nextVelocity = (velocity - omega * impulse) * decay
  // 目标在速度变化过程中回落时，弹簧不许越过目标来回摆。
  if ((offset < 0) === (nextRate > target)) {
    nextRate = target
    nextVelocity = 0
  }
  if (nextRate <= base || nextRate >= max) nextVelocity = 0
  return { charsPerSecond: clamp(nextRate, base, max), acceleration: nextVelocity }
}

export interface ResolveStreamPaceBudgetOptions {
  /** 当前帧距上一帧的真实时间。 */
  elapsedMs?: number
  /** 上一帧剩余的不足一字额度。 */
  carriedCharCredit?: number
  /** 上一帧之后的速度状态；缺省从基础速度静止起步。 */
  motion?: StreamPaceMotion
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
      motion: createStreamPaceMotion(tuning),
    }

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
  const previousMotion = options.motion ?? createStreamPaceMotion(tuning)
  const motion = advanceStreamPaceMotion(
    previousMotion,
    resolveStreamPaceTargetRate(backlogChars, tuning, previousMotion.charsPerSecond),
    elapsedMs / 1000,
    tuning
  )
  const carriedCharCredit = clamp(
    normalizeFinite(options.carriedCharCredit ?? 0, 0),
    0,
    maxCharsPerFrame
  )
  const availableCharCredit = clamp(
    carriedCharCredit + (motion.charsPerSecond * elapsedMs) / 1000,
    0,
    maxCharsPerFrame
  )

  return {
    charBudget: Math.min(backlogChars, Math.floor(availableCharCredit), maxCharsPerFrame),
    eventBudget,
    availableCharCredit,
    motion,
  }
}
