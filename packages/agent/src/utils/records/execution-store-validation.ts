import { isArray, isEmpty, isFiniteNumber, isNull, isObject, isPlainObject, isPresent, isString } from '@velaros-ai/core'

import type { ExecutionEventRecord, ExecutionRecord, ExecutionTaskRecord } from '../../types/agent.js'
import type { PersistedExecutionStoreFile } from '../../types/records.js'

/** 执行记录允许出现的全部状态词；校验持久化文件时用它挡掉手改过的、或来自更高版本的陌生状态。 */
const ExecutionStatuses = new Set<ExecutionRecord['status']>([
  'pending',
  'awaiting_confirmation',
  'running',
  'awaiting_input',
  'aborted',
  'completed',
  'failed',
])

/** 任务允许出现的全部状态词，作用同 `ExecutionStatuses`。 */
const ExecutionTaskStatuses = new Set<ExecutionTaskRecord['status']>([
  'pending',
  'running',
  'awaiting_confirmation',
  'awaiting_input',
  'aborted',
  'completed',
  'failed',
])

/** 账本事件允许出现的全部严重度词。 */
const ExecutionEventSeverities = new Set<ExecutionEventRecord['severity']>([
  'info',
  'success',
  'warning',
  'error',
])

/** 判断这个值是不是已知的执行状态词。 */
export function isExecutionStatus(value: unknown): value is ExecutionRecord['status'] {
  return isString(value) && ExecutionStatuses.has(value as ExecutionRecord['status'])
}

/** 判断这个值是不是已知的任务状态词。 */
export function isExecutionTaskStatus(value: unknown): value is ExecutionTaskRecord['status'] {
  return isString(value) && ExecutionTaskStatuses.has(value as ExecutionTaskRecord['status'])
}

/** 判断这个值是不是已知的事件严重度词。 */
export function isExecutionEventSeverity(value: unknown): value is ExecutionEventRecord['severity'] {
  return isString(value) && ExecutionEventSeverities.has(value as ExecutionEventRecord['severity'])
}

/** 判断这个值是 null 还是字符串；持久化记录里允许缺省的文本字段都按这个形状校验。 */
export function isNullableString(value: unknown): value is Nullable<string> {
  return isNull(value) || isString(value)
}

/** 执行是不是已经走到头了：aborted / completed / failed 三种算终态，只有终态记录会被容量淘汰。 */
export function isTerminalExecutionStatus(status: ExecutionRecord['status']): boolean {
  return status === 'aborted' || status === 'completed' || status === 'failed'
}

/** 任务是不是已经走到头了，取值规则同执行终态；重启恢复时只改非终态的任务。 */
export function isTerminalExecutionTaskStatus(status: ExecutionTaskRecord['status']): boolean {
  return status === 'aborted' || status === 'completed' || status === 'failed'
}

/** 校验一条持久化的任务记录是否完整到能安全参与恢复和调试图投影：缺字段、类型不对、状态词陌生的一律判否。 */
export function isExecutionTaskRecord(value: unknown): value is ExecutionTaskRecord {
  if (!isPlainObject(value)) return false
  const task = value
  return (
    isString(task.id) &&
    (task.kind === 'root' || task.kind === 'delegated') &&
    isString(task.title) &&
    isString(task.instruction) &&
    isArray(task.executionPlan) &&
    isExecutionTaskStatus(task.status) &&
    isFiniteNumber(task.createdAt) &&
    isFiniteNumber(task.updatedAt) &&
    (isNull(task.startedAt) || isFiniteNumber(task.startedAt)) &&
    (isNull(task.completedAt) || isFiniteNumber(task.completedAt)) &&
    isNullableString(task.result) &&
    isNullableString(task.error)
  )
}

/** 校验一条持久化的事件记录：除了字段形状，还要求它的 `executionId` 确实指向它所在的那条执行，防止串账。 */
export function isExecutionEventRecord(value: unknown, executionId: string): value is ExecutionEventRecord {
  if (!isPlainObject(value)) return false
  const event = value
  return (
    isString(event.id) &&
    event.executionId === executionId &&
    isString(event.kind) &&
    isExecutionEventSeverity(event.severity) &&
    isString(event.title) &&
    isString(event.message) &&
    isFiniteNumber(event.timestamp) &&
    isNullableString(event.taskId) &&
    isNullableString(event.planStepId) &&
    isObject(event.payload)
  )
}

/** 校验一条持久化的执行记录：字段形状之外，还要求任务列表非空、每条任务和事件都合法，且 `currentTaskId` 确实指向其中一条任务——焦点悬空的记录进不来。 */
export function isExecutionRecord(value: unknown): value is ExecutionRecord {
  if (!isPlainObject(value)) return false
  const record = value
  const executionId = record.id
  const currentTaskId = record.currentTaskId
  if (
    !isString(executionId) ||
    !isString(record.sourceSessionId) ||
    !isExecutionStatus(record.status) ||
    !isString(record.summary) ||
    !isNullableString(record.resourceId) ||
    !isFiniteNumber(record.createdAt) ||
    !isFiniteNumber(record.updatedAt) ||
    !isString(currentTaskId) ||
    !isArray(record.tasks) ||
    isEmpty(record.tasks) ||
    !isArray(record.events)
  ) return false

  const tasks = record.tasks
  if (!tasks.every((task) => isExecutionTaskRecord(task))) return false
  if (!tasks.some((task) => task.id === currentTaskId)) return false

  return record.events.every((event) => isExecutionEventRecord(event, executionId))
}

/** 校验整个持久化文件的外壳：版本号要和 `version` 对得上（对不上说明是别的版本写的，整份不读），存盘时刻是有限数字，执行列表是数组。 */
export function isPersistedExecutionStoreFile(value: unknown, version: number): value is PersistedExecutionStoreFile {
  if (!isPlainObject(value)) return false
  const record = value
  return (
    record.version === version &&
    isFiniteNumber(record.savedAt) &&
    isArray(record.executions)
  )
}

/** 敲定每条执行留多少事件：没给就用 `fallback`；给了非有限数或小于 1 直接抛错（这种配置多半是写错了，不该悄悄兜底），给了小数就向下取整。 */
export function resolveExecutionEventRetentionLimit(limit: Optional<number>, fallback: number): number {
  if (!isPresent(limit)) return fallback
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error('ExecutionStore 的 eventRetentionLimit 不合法：必须是不小于 1 的有限数字（小数会向下取整）；想用默认值就别传这一项。')
  }

  return Math.floor(limit)
}

/** 敲定最多留多少条终态执行记录，校验与取整规则同事件上限。 */
export function resolveExecutionRecordRetentionLimit(limit: Optional<number>, fallback: number): number {
  if (!isPresent(limit)) return fallback
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error('ExecutionStore 的 recordRetentionLimit 不合法：必须是不小于 1 的有限数字（小数会向下取整）；想用默认值就别传这一项。')
  }

  return Math.floor(limit)
}
