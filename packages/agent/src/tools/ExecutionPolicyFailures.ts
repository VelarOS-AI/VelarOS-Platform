import { isArray, isBigInt, isEmpty, isFunction,isNonBlankString, isObject, isPlainObject, isString, optionalWhen } from '@velaros-ai/core'
import { type AppError } from '@velaros-ai/core/error'
import { readStringScalar } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { ToolSpaceRecoveryGuide } from './tool-space-recovery'

interface ErrorCauseRecord {
  reason?: unknown
  details?: unknown
  suggestedNextAction?: unknown
  cause?: unknown
}

interface RuntimeToolIssue {
  severity: 'requires_diagnosis'
  action: 'model_report_diagnosis_then_continue_or_stop'
  requiredClassification: Array<'system_or_runtime_bug' | 'model_decision_issue'>
  systemBugBehavior: string
  modelDecisionBehavior: string
}

interface ToolFailureResult {
  error: string
  reason: string
  toolName: string
  code?: string
  details?: Record<string, unknown>
  nextActions?: string[]
  toolSpaceRecovery?: ToolSpaceRecoveryGuide
  runtimeToolIssue?: RuntimeToolIssue
}

interface ToolFailureBuildOptions {
  code?: string
  details?: Record<string, unknown>
  nextActions?: string[]
  recovery?: ToolSpaceRecoveryGuide
}

function extractNestedErrorReason(error: unknown): LooseOptional<string> {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && isObject(current) && !seen.has(current)) {
    seen.add(current)
    const record = current as ErrorCauseRecord
    if (isNonBlankString(record.reason)) return record.reason.trim()
    current = record.cause
  }
  return null
}

function extractNestedErrorDetails(error: unknown): LooseOptional<Record<string, unknown>> {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && isObject(current) && !seen.has(current)) {
    seen.add(current)
    const record = current as ErrorCauseRecord
    if (isPlainObject(record.details)) return record.details
    current = record.cause
  }
  return null
}

function extractNestedSuggestedNextAction(error: unknown): LooseOptional<string> {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && isObject(current) && !seen.has(current)) {
    seen.add(current)
    const record = current as ErrorCauseRecord
    if (isNonBlankString(record.suggestedNextAction)) return record.suggestedNextAction.trim()
    current = record.cause
  }
  return null
}

// cause 链上任意独立包（Project 等）都可能带回几十上百条 diagnostics 或超长字符串；
// 这里的数值是专为失败 details 选的——比 toolResultSerialization.ts 的模型工具结果档
// （maxArrayItems 400）严格得多，因为失败 details 会被直接持久化为工具结果的一部分，
// 裁掉的条目在当前边界内不可召回；只做体积/深度兜底，不追求语义完整。
const MaxDetailsArrayItems = 10
const MaxDetailsObjectKeys = 50
const MaxDetailsStringLength = 2_000
const MaxDetailsDepth = 6

function boundDetailsValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (isString(value))
    return value.length > MaxDetailsStringLength
      ? `${value.slice(0, MaxDetailsStringLength)}…`
      : value

  // BigInt 是 JSON.stringify 会直接抛错的少数几种基础类型，其余基础类型（number/boolean/
  // function/symbol/undefined）JSON.stringify 只会静默丢弃，不需要在这里特殊处理。
  if (isBigInt(value)) return `${value.toString()}n`

  if (!isObject(value)) return value

  if (seen.has(value)) return '[circular reference omitted]'

  if (depth >= MaxDetailsDepth)
    return isArray(value)
      ? `[array omitted at depth limit: ${value.length} items]`
      : '[object omitted at depth limit]'

  seen.add(value)

  if (isArray(value)) {
    const items = value
      .slice(0, MaxDetailsArrayItems)
      .map((item) => boundDetailsValue(item, depth + 1, seen))
    if (value.length > MaxDetailsArrayItems) {
      items.push({
        __truncatedItems: value.length - MaxDetailsArrayItems,
        originalLength: value.length,
      })
    }
    seen.delete(value)
    return items
  }

  // isPlainObject 把「非 null、非数组的 object」全部算作可用 Object.entries 遍历的记录，
  // Date/URL 这类没有自有可枚举属性、只靠 toJSON 表达状态的对象也会命中这条判断——按记录
  // 遍历会静默得到 {}，等于把值丢了。这里优先用其 toJSON（与 JSON.stringify 语义对齐）。
  const toJson = isFunction((value as { toJSON?: unknown }).toJSON)
    ? (value as { toJSON: () => unknown }).toJSON
    : null
  if (toJson) {
    seen.delete(value)
    try {
      return boundDetailsValue(toJson.call(value), depth, seen)
    } catch {
      // arch-guard:silent-catch-ok 领域对象的 toJSON 实现本身可能抛错；退化为不支持对象标记，
      // 不能让失败结果的构建被域对象内部问题打断。
      return `[omitted unsupported object: ${value.constructor?.name ?? 'unknown'}]`
    }
  }

  if (!isPlainObject(value)) {
    seen.delete(value)
    return `[omitted unsupported object: ${value.constructor?.name ?? 'unknown'}]`
  }

  const entries = Object.entries(value)
  const record: Record<string, unknown> = {}
  for (const [key, nestedValue] of entries.slice(0, MaxDetailsObjectKeys)) {
    record[key] = boundDetailsValue(nestedValue, depth + 1, seen)
  }
  if (entries.length > MaxDetailsObjectKeys) {
    record.__truncatedKeys = entries.length - MaxDetailsObjectKeys
    record.__originalKeyCount = entries.length
  }
  seen.delete(value)
  return record
}

/** 失败结果里的领域 details 有界投影：语义（reason/code/nextActions）不变，只裁体积。 */
function boundToolFailureDetails(details: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundDetailsValue(details, 0, new WeakSet())
  return isPlainObject(bounded) ? bounded : details
}

function shouldAnnotateRuntimeToolIssue(result: ToolFailureResult): boolean {
  return [
    'schema_validation_failed',
    'tool_unavailable',
    'tool_not_found',
    'tool_call_invalid',
    'tool_chain_invalid',
  ].includes(result.error)
}

function withRuntimeToolIssue(result: ToolFailureResult): ToolFailureResult {
  if (!shouldAnnotateRuntimeToolIssue(result) || result.runtimeToolIssue) return result

  const existingNextActions = result.nextActions ?? []
  return {
    ...result,
    runtimeToolIssue: {
      severity: 'requires_diagnosis',
      action: 'model_report_diagnosis_then_continue_or_stop',
      requiredClassification: ['system_or_runtime_bug', 'model_decision_issue'],
      systemBugBehavior:
        '如果归因是工具描述、schema、注册、运行态可用性或系统编排问题，先向用户报告根因并停止依赖该问题工具的原任务，等待修复或用户确认。',
      modelDecisionBehavior:
        '如果归因是模型自己的调用顺序、参数猜测、未先读取 schema 或并行编排判断问题，先向用户说明当时为什么这么做，再用修正后的流程继续推进。',
    },
    nextActions: [
      '先归因本次工具问题属于 system_or_runtime_bug 还是 model_decision_issue，并把判断依据告诉用户。',
      '若是 system_or_runtime_bug：报告工具/链路、入参、实际/期望、根因和建议修复位置；停止依赖该问题工具的原任务。',
      '若是 model_decision_issue：说明自己为什么做出该调用/编排决策，然后保留已有恢复线索继续执行。',
      ...existingNextActions,
    ],
  }
}

function readEmbeddedToolFailure(value: unknown): Nullable<ToolFailureResult> {
  if (!isObject(value)) return null
  const record = value as Partial<ToolFailureResult>
  if (!isNonBlankString(record.error) || !isNonBlankString(record.reason)) return null
  const result: ToolFailureResult = {
    error: record.error.trim(),
    reason: record.reason.trim(),
    toolName: readStringScalar(record.toolName) ?? 'unknown',
  }
  const code = optionalWhen(isNonBlankString, record.code)?.trim()
  const details = optionalWhen(isObject, record.details) as Record<string, unknown> | undefined
  const nextActions = optionalWhen(isArray, record.nextActions)?.filter(isString)
  const toolSpaceRecovery = optionalWhen(isObject, record.toolSpaceRecovery) as
    | ToolSpaceRecoveryGuide
    | undefined
  const runtimeToolIssue = optionalWhen(isObject, record.runtimeToolIssue) as
    | RuntimeToolIssue
    | undefined
  if (code) {
    result.code = code
  }
  if (details) {
    result.details = details
  }
  if (nextActions) {
    result.nextActions = nextActions
  }
  if (toolSpaceRecovery) {
    result.toolSpaceRecovery = toolSpaceRecovery
  }
  if (runtimeToolIssue) {
    result.runtimeToolIssue = runtimeToolIssue
  }
  return result
}

function buildToolFailureResult(
  error: string,
  reason: string,
  toolName: string,
  options: ToolFailureBuildOptions = {}
): ToolFailureResult {
  const result: ToolFailureResult = {
    error,
    reason,
    toolName,
  }

  if (options.code) {
    result.code = options.code
  }
  if (options.details) {
    result.details = options.details
  }
  if (options.nextActions?.length) {
    result.nextActions = options.nextActions
  }
  if (options.recovery) {
    result.nextActions = options.recovery.nextActions
    result.toolSpaceRecovery = options.recovery
  }

  return withRuntimeToolIssue(result)
}

function buildExecutionFailureResult(toolName: string, error: AppError): ToolFailureResult {
  const embeddedFailure = readEmbeddedToolFailure(error.context.toolFailure)
  if (embeddedFailure) return withRuntimeToolIssue(embeddedFailure)

  // 跨 Kernel/IPC 边界一趟 AppError.toJSON → fromJSON 往返会丢掉 cause（context 不丢），
  // 这时 cause 链上什么都读不到；镜像进 context 的领域错误对象（例如
  // packages/project/src/kernel-module.ts 的 projectCapabilityError 写入的
  // context.projectError）就是这种情况下唯一还在的诊断来源，作回退读取。
  const projectErrorMirror = error.context.projectError
  const nestedReason =
    extractNestedErrorReason(error) ?? extractNestedErrorReason(projectErrorMirror)
  const nestedDetails =
    extractNestedErrorDetails(error) ?? extractNestedErrorDetails(projectErrorMirror)
  const nestedSuggestedNextAction =
    extractNestedSuggestedNextAction(error) ??
    extractNestedSuggestedNextAction(projectErrorMirror)
  // 独立领域包可能用 reason 承载稳定机器码。AppError.from 会保留 cause，但不会把领域 reason
  // 冒充 Core code；Agent 边界在 UNKNOWN 时显式提升，避免真正原因只躺在 details 里。
  const effectiveCode = error.code === 'UNKNOWN' && nestedReason ? nestedReason : error.code
  const details: Record<string, unknown> = { ...(nestedDetails ?? {}) }
  if (nestedReason) {
    details.reason = nestedReason
  }
  if (effectiveCode) {
    details.code = effectiveCode
  }
  const boundedDetails = boundToolFailureDetails(details)

  return buildToolFailureResult(
    effectiveCode === 'EXECUTION_ABORTED'
      ? 'tool_cancelled'
      : effectiveCode === 'UNAVAILABLE'
        ? 'tool_unavailable'
      : effectiveCode === 'EXECUTION_DENIED' || effectiveCode === 'PERMISSION_DENIED' || effectiveCode === 'PERMISSION'
        ? 'tool_denied'
        : effectiveCode === 'TOOL_RESULT_FINALIZATION_FAILED'
          ? 'tool_result_finalization_failed'
        : 'tool_execution_failed',
    error.message,
    toolName,
    {
      code: effectiveCode,
      details: optionalWhen(!isEmpty(Object.keys(boundedDetails)), boundedDetails),
      nextActions: nestedSuggestedNextAction ? [nestedSuggestedNextAction] : undefined,
    }
  )
}

export {
  buildExecutionFailureResult,
  buildToolFailureResult,
  extractNestedErrorDetails,
  extractNestedErrorReason,
}
export type { RuntimeToolIssue, ToolFailureBuildOptions, ToolFailureResult }
