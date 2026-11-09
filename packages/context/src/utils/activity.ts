import type { TurnContextDelta } from '../types/activity.js'

/** 分离活动条目及已知的核实线索外壳；未知参数仍是宿主提供的不透明值，不增加可克隆限制。 */
export function snapshotTurnContextDelta(delta: TurnContextDelta): TurnContextDelta {
  return { ...delta, inspect: delta.inspect && { ...delta.inspect } }
}
