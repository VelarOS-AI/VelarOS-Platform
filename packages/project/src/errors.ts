// 域：Project 包的错误信封（稳定 reason 闭集 + 领域错误类 + thrown value 归一化）。
//
// **为什么不是 `AppError`**：本包是可独立发布、可脱离 velaros 宿主消费的能力包，错误面必须
// 自持；`ProjectError` 承担的是同一件事——**带机器可读 code**（`reason`）+ 结构化 details +
// **可执行的下一步**（`suggestedNextAction`），这三样是 agent 自救所需的全部信息。裸
// `new Error` 只有一句英文，模型看到只能重试。新增失败形态时先往 `ProjectErrorCode`
// 闭集加一项，别用 `INVALID_INPUT` 兜底掉真实原因。
import { isNull, isUndefined } from "@velaros-ai/core";

/** Project 工具使用的稳定、机器可读错误原因。 */
export type ProjectErrorCode =
  | 'PERMISSION_DENIED'
  | 'BASE_REVISION_MISMATCH'
  | 'TARGET_NOT_FOUND'
  | 'AMBIGUOUS_TARGET'
  | 'TARGET_EXISTS'
  | 'LOW_CONFIDENCE_TARGET'
  | 'ANCHOR_MISMATCH'
  | 'PATCH_PARSE_ERROR'
  | 'PATCH_APPLY_ERROR'
  | 'SCOPE_VIOLATION'
  | 'PROTECTED_FILE'
  | 'GENERATED_FILE'
  | 'VALIDATION_FAILED'
  | 'POSTCONDITION_FAILED'
  | 'FORMATTER_CHANGED_TOO_MUCH'
  | 'TEST_FAILED'
  | 'CONFLICT_WITH_EXTERNAL_EDIT'
  | 'TRANSACTION_RECOVERY_CONFLICT'
  | 'NOT_SUPPORTED'
  | 'INVALID_INPUT'

/**
 * 版本过期时的下一步。内核同时服务领域 SDK 与模型工具，只说「重读当前内容」，
 * 不点名 snapshot.revision、fileRef 这类某一侧协议的字段。
 */
export const RevisionMismatchSuggestedNextAction = '文件在读取后已被修改：请重新读取当前内容，再基于它修改。'

/** 命中 policy.generatedFiles 时的下一步：改生成器的输入再重新生成，而不是手改产物。 */
export const GeneratedFileSuggestedNextAction =
  '该路径匹配项目策略 generatedFiles：修改生成器的输入或配置，再用 project:run 执行生成命令；确需手工维护，请调整项目策略。'

/** 带结构化详情和 agent 恢复建议的领域错误。 */
export class ProjectError extends Error {
  reason: ProjectErrorCode
  details?: any
  suggestedNextAction?: string

  constructor(
    reason: ProjectErrorCode,
    message: string,
    details?: any,
    suggestedNextAction?: string
  ) {
    super(message)
    this.name = 'ProjectError'
    this.reason = reason
    this.details = details
    this.suggestedNextAction = suggestedNextAction
  }
}

/**
 * 将任意 thrown value 归一化成 JSON 安全的错误对象。
 * 入参写 `unknown` 而非 `any`：throw 出来的真的可能是任何值（含 null / undefined / 字符串），
 * `unknown` 会强制本函数把每种形态都显式收窄一遍——那正是它存在的理由。
 */
export function toErrorObject(error: unknown): Record<string, any> {
  if (error instanceof ProjectError) return {
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
