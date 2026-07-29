import { isNull, isUndefined } from "@velaros-ai/core";

/** workspace 工具和 CLI 输出使用的稳定、机器可读错误原因。 */
export type WorkspaceErrorCode =
  | 'PERMISSION_DENIED'
  | 'BASE_REVISION_MISMATCH'
  | 'TARGET_NOT_FOUND'
  | 'AMBIGUOUS_TARGET'
  | 'LOW_CONFIDENCE_TARGET'
  | 'ANCHOR_MISMATCH'
  | 'PATCH_PARSE_ERROR'
  | 'PATCH_APPLY_ERROR'
  | 'SCOPE_VIOLATION'
  | 'WHOLE_FILE_REWRITE_FORBIDDEN'
  | 'PROTECTED_FILE'
  | 'GENERATED_FILE'
  | 'VALIDATION_FAILED'
  | 'POSTCONDITION_FAILED'
  | 'FORMATTER_CHANGED_TOO_MUCH'
  | 'TEST_FAILED'
  | 'CONFLICT_WITH_EXTERNAL_EDIT'
  | 'NOT_SUPPORTED'
  | 'INVALID_INPUT'

/** 带结构化详情和 agent 恢复建议的领域错误。 */
export class WorkspaceError extends Error {
  reason: WorkspaceErrorCode
  details?: any
  suggestedNextAction?: string

  constructor(
    reason: WorkspaceErrorCode,
    message: string,
    details?: any,
    suggestedNextAction?: string
  ) {
    super(message)
    this.name = 'WorkspaceError'
    this.reason = reason
    this.details = details
    this.suggestedNextAction = suggestedNextAction
  }
}

/** 将任意 thrown value 归一化成 JSON 安全的错误对象。 */
export function toErrorObject(error: any): Record<string, any> {
  if (error instanceof WorkspaceError) return {
      name: error.name,
      reason: error.reason,
      message: error.message,
      details: error.details,
      suggestedNextAction: error.suggestedNextAction,
    }
  if (error instanceof Error) return { name: error.name, message: error.message }
  if (isNull(error)) return {
      name: 'NullError',
      message: '预期错误对象，但收到或抛出了 null。',
    }
  if (isUndefined(error)) return {
      name: 'UndefinedError',
      message: '预期错误对象，但收到或抛出了 undefined。',
    }
  return { message: String(error) }
}

/** 兼容旧调用方的别名。 */
export type WorkspaceFailureReason = WorkspaceErrorCode
