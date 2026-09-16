/**
 * 工具失败回执的统一信封：一次失败到底是「什么都没写」「整步跳过」还是「做到一半」，
 * 由 `context.executionOutcome` 一格说清，外面按码与这一格判断，不按失败文字猜。
 * 接口 `ToolFailuresApi` 在本文件的类上方；整个进程一份 `toolFailures`。
 */

import type { ErrorCode, ErrorContext } from '@velaros-ai/core/error'
import { AppError } from '@velaros-ai/core/error'

import { ToolDomainErrorContextKey, ToolExecutionOutcomes, ToolFailureLimits } from '../contract/constants.js'
import type { ToolFailureOptions } from '../types/tool-contract.js'

/**
 * 工具失败回执的唯一构造处，实例是 `toolFailures`。
 *
 * 三种结论：`not-applied` 一个字节都没落地（入参可原样复用后重发）、`skipped` 整步按策略跳过、
 * `failed` 做到一半才失败（已经落地的部分在 `applied` 里点名）。各空间只出自己的错误码，
 * 结论这一格由本包定形状，Agent 的失败提取端只认它，不再为某个空间开特例。
 */
export interface ToolFailuresApi {
  /** 失败回执里每个列表最多列几项；各空间的清单都按它截。 */
  readonly listItems: number
  /**
   * 造一条带结论的失败：`notApplied` 为真时标 `not-applied`，给了 `applied` 就标 `failed`
   * 并把已落地的部分截到 `listItems` 后带上，两者都没有时标 `skipped`。
   */
  create(code: ErrorCode, message: string, cause?: unknown, options?: ToolFailureOptions): AppError
  /** 把一份清单截到 `listItems` 项，失败回执里的每个列表都从这里过一道。 */
  listed<T>(items: readonly T[]): T[]
  /**
   * 把一个空间的领域错误翻成内核能力的 AppError：码与文字照搬，结构化详情镜像进
   * `context` 的 `ToolDomainErrorContextKey` 一格。跨 IPC 丢了 cause 之后，那一格是唯一还在的诊断来源。
   */
  domain(code: ErrorCode, message: string, cause: unknown, details: unknown): AppError
}

class ToolFailures implements ToolFailuresApi {
  public readonly listItems: number = ToolFailureLimits.listItems

  public create(
    code: ErrorCode,
    message: string,
    cause?: unknown,
    options: ToolFailureOptions = {}
  ): AppError {
    const context: ErrorContext = {
      executionOutcome: options.notApplied
        ? ToolExecutionOutcomes.notApplied
        : options.applied
          ? ToolExecutionOutcomes.failed
          : ToolExecutionOutcomes.skipped,
    }
    if (options.applied) context.applied = this.listed(options.applied)
    return new AppError(code, message, cause, context)
  }

  public listed<T>(items: readonly T[]): T[] {
    return items.slice(0, this.listItems)
  }

  public domain(code: ErrorCode, message: string, cause: unknown, details: unknown): AppError {
    return new AppError(code, message, cause, { [ToolDomainErrorContextKey]: details })
  }
}

/** 整个进程只有一份的失败回执构造器。 */
export const toolFailures: ToolFailuresApi = new ToolFailures()
