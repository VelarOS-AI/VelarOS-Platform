import {
  isBoolean,
  isEmpty,
  isFalse,
  isFiniteNumber,
  isNull,
  isPlainObject,
  isString,
  isTrue,
} from '@velaros-ai/core'

/** 只解释调用者显式交出的 JSON 字段，不探测进程、不扫描日志、不认证业务结果。 */
export function processOutputView(value: unknown, rawRef: string, pointer: string) {
  if (!isPlainObject(value)) return undefined
  const data = value as Record<string, unknown>
  const flags = [
    'failed',
    'timedOut',
    'isCanceled',
    'isGracefullyCanceled',
    'isTerminated',
    'isForcefullyTerminated',
    'isMaxBuffer',
    'aborted',
    'cleanupIncomplete',
  ]
  const fields = [
    ...flags,
    'exitCode',
    'signal',
    'code',
    'durationMs',
    'command',
    'cwd',
    'shortMessage',
    'logPath',
    'logBytes',
    'logTruncated',
  ]
  const facts: Record<string, unknown> = {}
  const invalidFields: string[] = []
  for (const key of fields) {
    if (!Object.hasOwn(data, key)) continue
    const v = data[key]
    const valid =
      flags.includes(key) || key === 'logTruncated'
        ? isBoolean(v)
        : key === 'exitCode'
          ? isNull(v) || (Number.isSafeInteger(v) && Number(v) >= 0)
          : key === 'durationMs' || key === 'logBytes'
            ? isFiniteNumber(v) && v >= 0
            : isNull(v) || isString(v)
    if (!valid) {
      invalidFields.push(key)
      continue
    }
    // 长诊断仍可从原字段召回；关键状态不与长文本竞争。
    facts[key] =
      isString(v) && v.length > 240
        ? {
            representation: 'reference',
            rawRef,
            pointer: `${pointer}/${key}`,
            totalChars: v.length,
          }
        : v
  }
  const failure =
    flags.some((key) => isTrue(data[key])) ||
    (isString(data.signal) && !isEmpty(data.signal)) ||
    (Number.isSafeInteger(data.exitCode) && Number(data.exitCode) > 0)
  const processStatus = failure
    ? 'failed'
    : isEmpty(invalidFields) &&
        data.exitCode === 0 &&
        isFalse(data.failed) &&
        (!Object.hasOwn(data, 'signal') || isNull(data.signal)) &&
        (!Object.hasOwn(data, 'code') || isNull(data.code))
      ? 'exited-zero'
      : 'unknown'
  const streams: Record<string, unknown> = {}
  for (const key of ['stdout', 'stderr']) {
    if (!Object.hasOwn(data, key)) continue
    streams[key] = {
      representation: 'reference',
      rawRef,
      pointer: `${pointer}/${key}`,
      ...(isString(data[key]) ? { totalChars: data[key].length, unit: 'utf16' } : {}),
    }
  }
  return {
    scope: 'caller-provided-process',
    processStatus,
    businessStatus: 'unknown',
    facts,
    invalidFields,
    streams,
  }
}
