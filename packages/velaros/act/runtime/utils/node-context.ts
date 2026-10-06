import {
  isArray,
  isEmpty,
  isNumber,
  isPlainObject,
  isString,
  isTrue,
  isUndefined,
} from '@velaros-ai/core'

import type { MemoryFrameDisplay } from '../types/memory.js'

/** 目标正文已逐字存在于本次用户历史时只列其范围；状态与依据仍取当前目标。 */
export function nodeGoalState(goal: unknown, inputs: readonly unknown[]): unknown {
  if (
    !isPlainObject(goal) ||
    !isString(goal.objective) ||
    !goal.objective ||
    Object.hasOwn(goal, 'objectiveInInput')
  )
    return goal
  for (const input of inputs) {
    if (
      !isPlainObject(input) ||
      !isTrue(input.bodyInHistory) ||
      !isString(input.text) ||
      !isNumber(input.offset) ||
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !isNumber(input.totalChars) ||
      !Number.isSafeInteger(input.totalChars) ||
      input.offset + input.text.length > input.totalChars ||
      !isPlainObject(input.record) ||
      !isPlainObject(input.record.ref) ||
      !isString(input.record.ref.sessionId) ||
      !input.record.ref.sessionId ||
      !isString(input.record.ref.id) ||
      !input.record.ref.id
    )
      continue
    const start = input.text.indexOf(goal.objective)
    if (start < 0) continue
    const { objective, ...metadata } = goal
    const compact = {
      ...metadata,
      objectiveInInput: {
        ref: input.record.ref,
        offset: input.offset + start,
        chars: objective.length,
      },
    }
    if (JSON.stringify(compact).length < JSON.stringify(goal).length) return compact
  }
  return goal
}

/** 标准环境只展示影响下一步的状态；完整内部帧仍用于授权、恢复和审计。 */
export function nodeFrameState(frame: MemoryFrameDisplay) {
  const {
    scope: _scope,
    programFrame: _programFrame,
    materialStatus,
    progress,
    ...runtime
  } = frame.runtime
  if (
    isPlainObject(progress) &&
    (progress.stalled ||
      Number(progress.repeatedSteps) > 0 ||
      (isArray(progress.evidence) && !isEmpty(progress.evidence)) ||
      (isPlainObject(progress.script) && progress.script.changed) ||
      (isPlainObject(progress.observation) && progress.observation.changed))
  )
    runtime.progress = progress
  if (isPlainObject(materialStatus)) {
    const {
      footprint: _footprint,
      largest: _largest,
      observationAction: _observationAction,
      ...visibility
    } = materialStatus
    runtime.materialStatus = visibility
  }
  if (isArray(runtime.children)) runtime.children = runtime.children.map(nodeChildState)
  const {
    footprint: _footprint,
    policy: _policy,
    advice: _advice,
    segment: _segment,
    ...status
  } = frame.status
  if (isPlainObject(frame.task.active) && isPlainObject(status.maintenance))
    status.maintenance = nodeMaintenanceState(status.maintenance, frame.task.active.items)
  const capsule = frame.workspace.capsule
  const directory = frame.workspace.residentDirectory
  const snapshot = frame.workspace.snapshot
  const workspaceVisible = Boolean(
    !isEmpty(frame.notes) ||
    frame.workspace.omitted ||
    (isPlainObject(capsule) &&
      Object.values(capsule).some((value) => (isArray(value) ? value.length : value))) ||
    (isPlainObject(directory) &&
      ((isArray(directory.items) && directory.items.length) || directory.omitted)) ||
    (isPlainObject(snapshot) &&
      (snapshot.notes ||
        snapshot.omitted ||
        (isArray(snapshot.sourcesChanged) && snapshot.sourcesChanged.length)))
  )
  return {
    workspaceVisible,
    observationVisible: Boolean(
      frame.source ||
      frame.output ||
      frame.observed.sourceRef ||
      frame.observed.resultRef ||
      (isArray(frame.observed.safety) && frame.observed.safety.length) ||
      (isArray(frame.observed.missingRequired) && frame.observed.missingRequired.length)
    ),
    runtime: nodeStateValues(runtime),
    status: nodeStateValues(status),
  }
}

/** 同帧待办共享当前项的完整正文；JSON Pointer 随当前次序重算，重复项与未匹配正文保持。 */
function nodeMaintenanceState(maintenance: unknown, items: unknown): unknown {
  if (!isPlainObject(maintenance) || !isArray(maintenance.unresolved) || !isArray(items))
    return maintenance
  const identities = new Set<string>()
  const bodies = new Map<string, number>()
  for (const [index, item] of items.entries()) {
    if (
      !isPlainObject(item) ||
      !isString(item.id) ||
      !item.id ||
      !isString(item.text) ||
      identities.has(item.id)
    )
      return maintenance
    identities.add(item.id)
    if (!bodies.has(item.text)) bodies.set(item.text, index)
  }
  const unresolved = maintenance.unresolved.map((text) => {
    if (!isString(text) || !text) return text
    const index = bodies.get(text)
    if (isUndefined(index)) return text
    const reference = { textAt: `/task/active/items/${index}/text` }
    return JSON.stringify(reference).length < JSON.stringify(text).length ? reference : text
  })
  return { ...maintenance, unresolved }
}

/** 子任务的状态与交付入口保持当前值；不可变产物目录按清单引用读取，避免每轮重复脚本身份。 */
function nodeChildState(child: unknown): unknown {
  if (!isPlainObject(child) || !isPlainObject(child.delivery)) return child
  const delivery = child.delivery
  const ref = delivery.ref
  if (
    !isPlainObject(ref) ||
    !isString(ref.sessionId) ||
    !ref.sessionId ||
    !isString(ref.id) ||
    !ref.id ||
    !isArray(delivery.artifacts)
  )
    return child
  const { artifacts, ...metadata } = delivery
  const summary = { ...metadata, artifactCount: artifacts.length, artifactsInManifest: true }
  return JSON.stringify(summary).length < JSON.stringify(delivery).length
    ? { ...child, delivery: summary }
    : child
}

/** 只省略运行时直属的空分区；不遍历业务负载，空值、数组顺序和重复项保持原样。 */
function nodeStateValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => !(isArray(item) || isPlainObject(item)) || !isEmpty(Object.keys(item))
    )
  )
}
