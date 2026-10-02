import { isNumber, isPlainObject, isString, isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { SnapshotObservationCapture } from '../types/runtime.js'

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
