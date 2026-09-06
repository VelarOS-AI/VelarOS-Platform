import { isArray, isEmpty,isNonBlankString, isObject, isString, optionalWhen } from '@velaros-ai/core'
import { type AppError } from '@velaros-ai/core/error'
import { readStringScalar } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { ToolSpaceRecoveryGuide } from './tool-space-recovery'

interface ErrorCauseRecord {
  reason?: unknown
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

  const nestedReason = extractNestedErrorReason(error)
  const nestedSuggestedNextAction = extractNestedSuggestedNextAction(error)
  // 独立领域包可能用 reason 承载稳定机器码。AppError.from 会保留 cause，但不会把领域 reason
  // 冒充 Core code；Agent 边界在 UNKNOWN 时显式提升，避免真正原因只躺在 details 里。
  const effectiveCode = error.code === 'UNKNOWN' && nestedReason ? nestedReason : error.code
  const details: Record<string, unknown> = {}
  if (nestedReason) {
    details.reason = nestedReason
  }
  if (effectiveCode) {
    details.code = effectiveCode
  }

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
      details: optionalWhen(!isEmpty(Object.keys(details)), details),
      nextActions: nestedSuggestedNextAction ? [nestedSuggestedNextAction] : undefined,
    }
  )
}

export {
  buildExecutionFailureResult,
  buildToolFailureResult,
  extractNestedErrorReason,
}
export type { RuntimeToolIssue, ToolFailureBuildOptions, ToolFailureResult }
