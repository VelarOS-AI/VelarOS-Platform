import { createHash } from 'node:crypto'

import type { ContextContent } from '@velaros-ai/context'
import { Log } from '@velaros-ai/core'
import {
  isArray,
  isBoolean,
  isEmpty,
  isFiniteNumber,
  isNull,
  isObject,
  isPlainObject,
  isString,
  optionalWhen,
  stringifyPretty,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { unifiedLineDiff } from '@velaros-ai/core/utils/textDiff'

import type { ScriptControlIdentity } from '../types/runtime.js'
import type { ScriptSubmissionReceipt } from '../types/session.js'

import { ActRuntimeTuning } from './tuning.js'

/** 从 Runtime 回执提取有限纠错信息，使结果正文引用化后仍能定位最近一次失败。 */
export function programFailure(value: unknown) {
  if (!isPlainObject(value)) return undefined
  const receipt = value as {
    status?: string
    observe?: unknown
    execute?: unknown
    executions?: unknown[]
    result?: { failed?: unknown }
    error?: unknown
  }
  const rejected = [receipt.observe, receipt.execute, ...(receipt.executions ?? [])].find(
    (item) => isObject(item) && Reflect.get(item, 'status') === 'rejected'
  )
  const failure = rejected ?? receipt.result?.failed ?? receipt.error
  if (!isObject(failure)) return isString(failure) ? { message: failure.slice(0, 800) } : undefined
  const data = failure as {
    code?: unknown
    message?: unknown
    draftRef?: unknown
    diagnostics?: Array<{ line?: number; column?: number; message?: unknown; frame?: unknown }>
  }
  return {
    code: isString(data.code) ? data.code.slice(0, 80) : undefined,
    message: isString(data.message) ? data.message.slice(0, 800) : '执行失败，请读取完整回执',
    draftRef: optionalWhen(isString, data.draftRef),
    diagnostics: data.diagnostics?.slice(0, 3).map((item) => ({
      line: item.line,
      column: item.column,
      message: isString(item.message) ? item.message.slice(0, 500) : undefined,
      frame: isString(item.frame) ? item.frame.slice(0, 240) : undefined,
    })),
    omittedDiagnostics: Math.max(0, (data.diagnostics?.length ?? 0) - 3),
  }
}

/** 输出比较只取脚本结果，执行身份与调用日志留在原始审计记录。 */
export function programContentText(content: Optional<ContextContent>, source = false): string {
  if (!content) return ''
  try {
    const data = JSON.parse(content.text)
    if (source && isString(data.source)) return data.source
    if (!source) return stringifyPretty(data.result ?? data)
  } catch {
    Log.tag('ActRuntime').debug(
      'program-context 已进入异常处理或降级分支'
    ) /* 截取材料无法解析时保留原文与截断标记。 */
  }
  return content.text
}

/** 差量仅说明变化，当前正文独立提供；缺少完整基线时不声称没有变化。 */
export function programContentChange(
  before: Optional<ContextContent>,
  after: Optional<ContextContent>,
  source = false
): { changed: boolean; patch: string; truncated: boolean; purpose: 'change-summary' } {
  const comparable = (content: Optional<ContextContent>): string => {
    const text = programContentText(content, source)
    if (source && content)
      try {
        const { source: _source, ...configuration } = JSON.parse(content.text)
        if (!isEmpty(Object.keys(configuration)))
          return `${text}\n// modules / input / blobs\n${stringifyPretty(configuration)}`
      } catch {
        Log.tag('ActRuntime').debug(
          'program-context 已进入异常处理或降级分支'
        ) /* 截断状态由下方完整性标记说明。 */
      }
    return text
  }
  const a = comparable(before)
  const b = comparable(after)
  const incomplete = Boolean(
    (before && before.totalChars > before.text.length) ||
    (after && after.totalChars > after.text.length)
  )
  const changed = incomplete ? before?.record.objectId !== after?.record.objectId : a !== b
  const patch = changed
    ? unifiedLineDiff(a, b, {
        from: before?.record.ref.id ?? 'empty',
        to: after?.record.ref.id ?? 'empty',
        editLimit: ActRuntimeTuning.edits,
        contextLines: 2,
      })
    : ''
  return {
    changed,
    patch: patch.slice(0, 1600),
    truncated: incomplete || patch.length > 1600,
    purpose: 'change-summary',
  }
}

/** 递归稳定键顺序，用于比较同一控制调用的输入；数组保留顺序。 */
export function stableProgramJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    isPlainObject(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  )
}

/** 宿主调用身份包含会话范围，模型调用 ID 只作为已接受响应身份的一部分。 */
export function scriptControlIdentity(
  sessionId: string,
  callId: string,
  operation: string,
  input: unknown,
  expectedObservation: Nullable<string>
): ScriptControlIdentity {
  const hash = createHash('sha256')
    .update(stableProgramJson([sessionId, callId]))
    .digest('hex')
    .slice(0, 32)
  return {
    id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`,
    fingerprint: createHash('sha256').update(stableProgramJson({ operation, input })).digest('hex'),
    expectedObservation,
  }
}

/** 固定脚本提交的 JSON 参数，拒绝无法无损持久化的数据。 */
export function scriptInputCopy<T>(input: T): T {
  const seen = new Set<object>()
  const copy = (value: unknown): unknown => {
    if (isNull(value) || isString(value) || isBoolean(value) || isFiniteNumber(value)) return value
    if (
      (!isObject(value) && !isNull(value)) ||
      seen.has(value) ||
      (!isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    )
      throw AppError.withFields('INPUT_SCHEMA', '脚本参数必须是无环 JSON 值', { effect: 'none' })
    seen.add(value)
    const result = isArray(value)
      ? value.map(copy)
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))
    seen.delete(value)
    return Object.freeze(result)
  }
  return copy(input) as T
}

/** 已占位但缺少完成回执的提交必须核对，任何恢复路径都不能授权重跑。 */
export function recoverScriptSubmission(
  receipt: ScriptSubmissionReceipt,
  control: ScriptControlIdentity
): ScriptSubmissionReceipt {
  if (receipt.status === 'prepared')
    throw AppError.withFields('SCRIPT_UNRESOLVED', '原提交已占位但缺少最终回执，需要核对执行效果', {
      invocationId: control.id,
      effect: 'unknown',
    })
  return receipt
}
