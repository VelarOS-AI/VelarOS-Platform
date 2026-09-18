// 域：Project 包的错误信封（稳定 reason 闭集 + 领域错误类 + thrown value 归一化）。
//
// **为什么不是 `AppError`**：本包是可独立发布、可脱离 velaros 宿主消费的能力包，错误面必须
// 自持；`ProjectError` 承担的是同一件事——**带机器可读 code**（`reason`）+ 结构化 details +
// **可执行的下一步**（`suggestedNextAction`），这三样是 agent 自救所需的全部信息。裸
// `new Error` 只有一句英文，模型看到只能重试。新增失败形态时先往合同常量表 `ProjectErrorCodes`
// 加一项，别用 `INVALID_INPUT` 兜底掉真实原因。
import { isNull, isUndefined } from "@velaros-ai/core";
import { AppError } from '@velaros-ai/core/error'
import { TextFileErrorCodes } from '@velaros-ai/text-files/contracts'

import { type ProjectErrorCode, ProjectErrorCodes } from "../contract/constants.js";

/**
 * 版本过期时的下一步。内核同时服务领域 SDK 与模型工具，只说「重读当前内容」，
 * 不点名 snapshot.revision、fileRef 这类某一侧协议的字段。
 */
export const RevisionMismatchSuggestedNextAction = '文件在读取后已被修改：请重新读取当前内容，再基于它修改。'

/** 项目空间的领域错误：reason 是合同里的错误原因，details 是结构化详情，suggestedNextAction 是给模型的下一步。 */
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
 * 公共件 text-files 的错误码对到项目的错误原因。tooLarge 在项目里只出现在事务核对原字节的有界读上，
 * 超出预期长度就是文件被外部改过，所以和 externalEdit 一样按外部修改冲突处理。
 */
const TextFileErrorReasons: ReadonlyMap<string, ProjectErrorCode> = new Map([
  [TextFileErrorCodes.notText, ProjectErrorCodes.notSupported],
  [TextFileErrorCodes.lossy, ProjectErrorCodes.invalidInput],
  [TextFileErrorCodes.externalEdit, ProjectErrorCodes.conflictWithExternalEdit],
  [TextFileErrorCodes.notRegular, ProjectErrorCodes.notSupported],
  [TextFileErrorCodes.tooLarge, ProjectErrorCodes.conflictWithExternalEdit],
  [TextFileErrorCodes.invalidMode, ProjectErrorCodes.invalidInput],
])

/**
 * 公共件 `@velaros-ai/text-files` 的失败按错误码翻成 `ProjectError`（文字照搬成 message，context 照搬成 details）；别的错误原样返回。
 * 调 text-files 的地方都在失败时 `throw projectErrorFromTextFile(error)`，按 `ProjectError` 分支的现有逻辑因此一处不用改。
 */
export function projectErrorFromTextFile(error: unknown): unknown {
  if (!(error instanceof AppError)) return error
  const reason = TextFileErrorReasons.get(error.code)
  return isUndefined(reason) ? error : new ProjectError(reason, error.message, { ...error.context })
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
