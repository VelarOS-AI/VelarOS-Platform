import { isEmpty, isNumber, isPlainObject, isString, isTrue, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { OperationLimits } from '@velaros-ai/kernel'

import { ObservationLimits } from '../contract/constants.js'
import type { ObservationHistoryRequest } from '../types/observation.js'
import type { SnapshotObservationCapture } from '../types/runtime.js'

/** 普通观察只按实际材料判定内容身份，执行号、计时和成本不产生新快照。 */
export function observationResultValue(value: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(value.result))
    throw new AppError('UNAVAILABLE', '观察结果缺少实际材料')
  const result = { ...value.result }
  if (isPlainObject(result.process)) {
    const { logPath: _logPath, logBytes: _logBytes, ...process } = result.process
    result.process = process
  }
  if (isUndefined(value.output)) return { result }
  return { result, output: value.output }
}

/** 宿主与模型共用同一份小型历史选择；目录游标与正文范围均不能扩张预算。 */
export function observationHistoryRequest(
  value: ObservationHistoryRequest
): ObservationHistoryRequest {
  if (!isPlainObject(value)) throw new AppError('VALIDATION', '观察历史选择必须是对象')
  if (value.kind === 'list') {
    const limit = value.limit ?? ObservationLimits.defaultList
    if (
      Object.keys(value).some((key) => !['kind', 'cursor', 'limit'].includes(key)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > ObservationLimits.maxList ||
      (!isUndefined(value.cursor) &&
        (!isString(value.cursor) ||
          !value.cursor ||
          value.cursor.length > ObservationLimits.maxChars))
    )
      throw new AppError('VALIDATION', '观察历史目录分页无效')
    if (isUndefined(value.cursor)) return { kind: 'list', limit }
    return { kind: 'list', limit, cursor: value.cursor }
  }
  if (value.kind !== 'read') throw new AppError('VALIDATION', '观察历史只支持 list 或 read')
  const offset = value.offset ?? 0
  const limit = value.limit ?? ObservationLimits.defaultReadChars
  if (
    Object.keys(value).some(
      (key) => !['kind', 'snapshotId', 'pointer', 'offset', 'limit'].includes(key)
    ) ||
    !isString(value.snapshotId) ||
    !value.snapshotId ||
    value.snapshotId.length > ObservationLimits.maxChars ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ObservationLimits.maxReadChars ||
    (!isUndefined(value.pointer) &&
      (!isString(value.pointer) ||
        value.pointer.length > ObservationLimits.maxChars ||
        (!isEmpty(value.pointer) && !value.pointer.startsWith('/')) ||
        /~(?![01])/u.test(value.pointer)))
  )
    throw new AppError('VALIDATION', '观察历史读取范围无效')
  return { ...value, offset, limit }
}

/** 只接受固定领域捕获返回的完整纯值回执，未知、部分结果和未结算调用均不可复用。 */
export function completeSnapshot(value: unknown): SnapshotObservationCapture {
  if (
    !isPlainObject(value) ||
    !isTrue(value.complete) ||
    !isString(value.providerId) ||
    !value.providerId ||
    !isString(value.fingerprint) ||
    !value.fingerprint ||
    !isString(value.checkedAt) ||
    !Number.isFinite(Date.parse(value.checkedAt)) ||
    !isNumber(value.readRequests) ||
    !Number.isSafeInteger(value.readRequests) ||
    value.readRequests < 0 ||
    !isNumber(value.materialBytes) ||
    !Number.isSafeInteger(value.materialBytes) ||
    value.materialBytes < 0 ||
    !Object.hasOwn(value, 'value')
  )
    throw new AppError('UNAVAILABLE', '领域未提供完整的当前纯快照')
  const serialized = JSON.stringify(value.value)
  if (isUndefined(serialized)) throw new AppError('UNAVAILABLE', '领域纯快照没有可归档的当前值')
  if (serialized.length > OperationLimits.observationChars)
    throw new AppError('LIMIT', '观察捕获超过小型状态上限，请收窄计划后重新采集')
  return {
    complete: true,
    providerId: value.providerId,
    fingerprint: value.fingerprint,
    checkedAt: value.checkedAt,
    readRequests: value.readRequests,
    materialBytes: value.materialBytes,
    value: value.value,
  }
}
