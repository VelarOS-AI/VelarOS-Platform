/**
 * 流式起搏预算（纯函数，无副作用、无环境全局，便于单测）。
 *
 * 设计目标：
 *  - 平稳：空闲时按 base 速率匀速吐字 / 应用事件。
 *  - 自适应：文本积压越多，单 tick 字符预算越大，渲染追得越快。
 *  - 单结构更新：结构事件固定每 tick 一个，避免多个块同帧更新造成卡顿。
 *  - 有界滞后：文本积压超过 hardCap 时排空文本（forceDrain），结构事件仍逐帧应用。
 */

export interface StreamPaceBacklog {
  /** 尚未吐出的文本/思考字符数。 */
  backlogChars: number
  /** 尚未应用的离散结构事件数。 */
  backlogEvents: number
}

export interface StreamPaceBudget {
  /** 本 tick 最多吐出的字符数。 */
  charBudget: number
  /** 本 tick 最多应用的结构事件数。 */
  eventBudget: number
  /** 为 true 时本 tick 直接排空全部积压（积压超上限的兜底）。 */
  forceDrain: boolean
}

export interface StreamPaceTuning {
  baseChars: number
  charGain: number
  maxChars: number
  hardCapChars: number
  baseEvents: number
}

/** 默认起搏参数；可在起搏器构造时覆盖，落地后按手感调。 */
export const DefaultStreamPaceTuning: StreamPaceTuning = {
  // 正文逐字打字效果：每帧只吐少量字符，避免一次性把整段答案瞬现。
  // baseChars 为空闲匀速；charGain 为积压追赶增益；maxChars 封顶单帧吐字（防瞬现）。
  baseChars: 16,
  charGain: 0.06,
  maxChars: 160,
  // hardCap 触发 forceDrain（整批瞬排）——这是"正文突然出现一大块"的根因：快模型/大块 IPC
  // delta 把积压瞬间顶过阈值时，整段正文会在一帧里全吐出。调高到只对病态级（>10 万字）兜底，
  // 正常长度的回答即使来得很快，也始终按 maxChars 逐帧平滑吐字；收尾残余由 smooth 模式吐完。
  hardCapChars: 100000,
  baseEvents: 1,
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

export interface ResolveStreamPaceBudgetOptions {
  /**
   * 平滑收尾模式：禁用 hardCap 整批排空（forceDrain），即使积压很大也按 maxChars 上限
   * 逐帧匀速吐完。收到 end/done 后用它把残余积压"平滑收尾"，避免正文一次性闪现。
   */
  smooth?: boolean
}

export function resolveStreamPaceBudget(
  backlog: StreamPaceBacklog,
  tuning: StreamPaceTuning = DefaultStreamPaceTuning,
  options: ResolveStreamPaceBudgetOptions = {}
): StreamPaceBudget {
  const backlogChars = Math.max(0, backlog.backlogChars)
  const eventBudget = Math.max(1, Math.floor(tuning.baseEvents))

  if (!options.smooth && backlogChars >= tuning.hardCapChars) return {
      charBudget: Math.max(backlogChars, tuning.maxChars),
      eventBudget,
      forceDrain: true,
    }

  return {
    charBudget: clamp(
      Math.ceil(tuning.baseChars + backlogChars * tuning.charGain),
      tuning.baseChars,
      tuning.maxChars
    ),
    eventBudget,
    forceDrain: false,
  }
}
