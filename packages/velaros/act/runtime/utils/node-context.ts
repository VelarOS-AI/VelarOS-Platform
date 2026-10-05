import { isArray, isEmpty, isPlainObject, isString } from '@velaros-ai/core'

import type { MemoryFrameDisplay } from '../types/memory.js'

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
