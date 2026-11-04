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
export function nodeFrameState(
  frame: MemoryFrameDisplay,
  previous?: MemoryFrameDisplay
): {
  workspaceVisible: boolean
  observationVisible: boolean
  runtime: Record<string, unknown>
  status: Record<string, unknown>
} {
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
      isPlainObject(progress.feedback) ||
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
  if (isArray(runtime.children))
    runtime.children = nodeChildrenState(
      runtime.children,
      previous?.presentation === 'node' ? previous.runtime.children : undefined
    )
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
  const changes = nodeJobChanges(
    runtime.jobs,
    previous?.presentation === 'node' ? previous.runtime.jobs : undefined
  )
  if (!isEmpty(changes))
    runtime.jobChanges = {
      items: changes,
      meaning:
        '以本帧 jobs 为准；terminal:true 表示该执行已结束，无需继续等待该执行。unknown 不证明终态；succeeded 仅表示执行成功，不等于业务验证通过，须核对 resultRef 原始结果。',
    }
  const currentRuntime = nodeStateValues(runtime)
  if (previous?.presentation === 'node') {
    const earlier = nodeFrameState(previous).runtime
    const unchanged: string[] = []
    // 只复用完整相同的大目录；运行目标、失败回执、缺口和进展仍逐帧独立交付。
    for (const key of ['inventory', 'jobs', 'materialStatus']) {
      const text = JSON.stringify(currentRuntime[key])
      if (!text || text.length < 256 || text !== JSON.stringify(earlier[key])) continue
      unchanged.push(key)
      delete currentRuntime[key]
    }
    if (!isEmpty(unchanged)) currentRuntime.unchangedInEarlierFrame = unchanged
  }
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
    runtime: currentRuntime,
    status: nodeStateValues(status),
  }
}

/** 只比较权威状态与结果引用，不从输出文本推断检查成功，也不重复日志。 */
function nodeJobChanges(jobs: unknown, previous: unknown): Array<Record<string, unknown>> {
  const earlier = new Map<string, Record<string, unknown> | null>()
  for (const job of nodeJobs(previous))
    earlier.set(job.executionId, earlier.has(job.executionId) ? null : job)
  return nodeJobs(jobs).flatMap((job) => {
    const before = earlier.get(job.executionId)
    if (before && before.status === job.status && before.resultRef === job.resultRef) return []
    return [
      {
        ...job,
        ...(before ? { previousStatus: before.status } : {}),
        terminal: ['succeeded', 'failed', 'cancelled'].includes(job.status),
      },
    ]
  })
}

/** 展开已完成分组仅用于比较；原始作业、失败详情和未知形状仍在 jobs 中保留。 */
function nodeJobs(jobs: unknown): Array<{
  executionId: string
  status: string
  resultRef?: unknown
}> {
  if (!isArray(jobs)) return []
  return jobs.flatMap((job) => {
    if (!isPlainObject(job)) return []
    if (
      job.representation === 'completed-jobs' &&
      job.status === 'succeeded' &&
      isPlainObject(job.results)
    )
      return Object.entries(job.results).map(([executionId, resultRef]) => ({
        executionId,
        status: 'succeeded',
        resultRef,
      }))
    if (!isString(job.executionId) || !job.executionId || !isString(job.status)) return []
    return [{ executionId: job.executionId, status: job.status, resultRef: job.resultRef }]
  })
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

/** 仅复用逐字不变的成功交付；失败、待处理请求、身份歧义及首帧保持完整。 */
function nodeChildrenState(children: unknown[], previous: unknown): unknown[] {
  const old = isArray(previous) ? previous : []
  return children.map((child) => {
    const projected = nodeChildState(child)
    if (
      !isPlainObject(child) ||
      !isString(child.id) ||
      !child.id ||
      child.status !== 'completed' ||
      child.error ||
      (isPlainObject(child.delivery) && child.delivery.status !== 'completed') ||
      (isArray(child.pending) && child.pending.length) ||
      !isPlainObject(child.result) ||
      !isString(child.result.sessionId) ||
      !child.result.sessionId ||
      !isString(child.result.id) ||
      !child.result.id ||
      children.filter((item) => isPlainObject(item) && item.id === child.id).length !== 1
    )
      return projected
    const matches = old.filter((item) => isPlainObject(item) && item.id === child.id)
    if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(child))
      return projected
    const compact = {
      id: child.id,
      sessionId: child.sessionId,
      status: child.status,
      result: child.result,
      unchangedInEarlierFrame: true,
    }
    return JSON.stringify(compact).length < JSON.stringify(projected).length ? compact : projected
  })
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
