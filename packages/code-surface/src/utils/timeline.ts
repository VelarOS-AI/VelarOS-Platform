/** 时间线记录上的几件判断与挑拣：清过没有、某个时间点的标记、history 按条件挑哪些。不碰实例状态。 */

import { isNull, isNumber, isPlainObject, isString, isUndefined } from '@velaros-ai/core'

import type { MarkerStatCache, TimelineCallView, TimelineRecord, TimelineStepRecord } from '../types/timeline.js'

import { stepRef } from './refs.js'

/** 日志里读回来的一行像不像一条记录：是对象，t 是 call 或 step，call 是数。写到一半的坏行不算。 */
export function isTimelineRecord(value: unknown): value is TimelineRecord {
  return isPlainObject(value) && (value.t === 'call' || value.t === 'step') && isNumber(value.call)
}

/** 读回来的 stat 缓存像不像样：root 是字符串，files 是对象。 */
export function isMarkerStatCache(value: unknown): value is MarkerStatCache {
  return isPlainObject(value) && isString(value.root) && isPlainObject(value.files)
}

/** 这次调用被保留上限清过没有：开头没有标记，每一步都没有结果、参数与标记。 */
export function isClearedCall(view: TimelineCallView): boolean {
  return isUndefined(view.record.marker)
    && view.steps.every((step) => isUndefined(step.result) && isUndefined(step.input) && isUndefined(step.blobs) && isUndefined(step.marker))
}

/**
 * 某个时间点工作区的标记：给了 step 是那一步做完时，没给是那次调用做完时。
 * 从那次调用开头的标记起，往后顺着每一步做完时的标记走（没改工作区、没跑的步骤不打标记，标记不变）。
 * 那次调用开头没有标记（没打成、或者被保留上限清掉了）时交回 undefined。
 */
export function markerAt(views: readonly TimelineCallView[], call: number, step?: number): Optional<string> {
  const view = views.find((candidate) => candidate.record.call === call)
  let marker = view?.record.marker
  if (isUndefined(view) || isUndefined(marker)) return undefined
  for (const record of view.steps) {
    if (!isUndefined(step) && record.step > step) break
    marker = record.marker ?? marker
  }
  return marker
}

/** 这一步和某个脚本有关：写过、改过、退回过、从它跑过，或者跑的时候 import 了它。 */
function touchesScript(step: TimelineStepRecord, script: string): boolean {
  return step.path === script || step.base === script || Boolean(step.base?.startsWith(`${script}@`)) || !isUndefined(step.deps?.[script])
}

/**
 * history 按条件挑：每一步是一条，调用开头发现的外部改动在按文件筛时也算一条；只留最近的 limit 条，按先后排、按调用分组。
 * omitted 是更早的、没列出的条数。
 */
export function selectHistory(
  views: readonly TimelineCallView[],
  filter: { script?: string; file?: string; from?: number; to?: number; limit: number },
): { calls: Array<{ view: TimelineCallView; steps: TimelineStepRecord[] }>; omitted: number } {
  const entries: Array<{ view: TimelineCallView; step?: TimelineStepRecord }> = []
  for (const view of views) {
    const call = view.record.call
    if ((!isUndefined(filter.from) && call < filter.from) || (!isUndefined(filter.to) && call > filter.to)) continue
    const file = filter.file
    if (!isUndefined(file) && view.record.external?.some((change) => change.path === file)) entries.push({ view })
    for (const step of view.steps) {
      if (!isUndefined(filter.script) && !touchesScript(step, filter.script)) continue
      if (!isUndefined(file) && !step.changes?.some((change) => change.path === file)) continue
      entries.push({ view, step })
    }
  }
  const kept = entries.slice(Math.max(0, entries.length - filter.limit))
  const calls: Array<{ view: TimelineCallView; steps: TimelineStepRecord[] }> = []
  for (const entry of kept) {
    let group = calls.at(-1)
    if (group?.view !== entry.view) {
      group = { view: entry.view, steps: [] }
      calls.push(group)
    }
    if (entry.step) group.steps.push(entry.step)
  }
  return { calls, omitted: entries.length - kept.length }
}

/**
 * replay 给一段调用号时要重放的步骤：那一段里（不含这一次调用）跑成了、改过文件的 run 与 replay，按先后排。
 * to 没给是到最近一次；from、to 写得不是调用号（null）时一个都没有。
 */
export function replayTargets(views: readonly TimelineCallView[], from: Optional<Nullable<number>>, to: Optional<Nullable<number>>, current: number): TimelineStepRecord[] {
  if (isUndefined(from) || isNull(from) || isNull(to)) return []
  return views
    .filter((view) => view.record.call >= from && (isUndefined(to) || view.record.call <= to) && view.record.call !== current)
    .flatMap((view) => view.steps.filter((step) => (step.op === 'run' || step.op === 'replay') && step.ok && Boolean(step.changes?.length)))
}

/** 一段步骤做完之后每个文件该是什么样：按先后走，后改的算数；删掉的记成 undefined。 */
export function rangeEndState(steps: readonly TimelineStepRecord[]): Map<string, Optional<string>> {
  const end = new Map<string, Optional<string>>()
  for (const step of steps) for (const change of step.changes ?? []) end.set(change.path, change.after)
  return end
}

/** 步骤号写成 `C12.2`（给展开出来的那几步用）。 */
export function stepRefOf(step: TimelineStepRecord): string {
  return stepRef(step.call, step.step)
}
