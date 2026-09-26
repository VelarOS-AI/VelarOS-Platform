/**
 * 事务失败回执：模型看得到的失败错误都在这里构造——没写入的结论、revision 冲突、编辑失败后的回读建议、校验诊断信封。
 * 回执带几条诊断、每条多长由 `ProjectTuning.transactions` 管。
 */

import { isEmpty, isPlainObject, isPresent, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { Diagnostic } from '../../types/common.js'
import type { ValidationResult } from '../../types/validation.js'
import { ProjectError, RevisionMismatchSuggestedNextAction } from '../errors.js'
import { ProjectTuning } from '../tuning.js'

/**
 * 写盘开始之前失败：原错误照旧抛出，只补上「没有写入」的结论。Agent 边界据此把失败记为 not-applied，
 * 模型改好之后可以原样重提；写盘开始之后的失败不能这样标。
 */
export function withNotAppliedOutcome(error: unknown): Error {
  if (error instanceof ProjectError)
    return new ProjectError(
      error.reason,
      error.message,
      { ...error.details, executionOutcome: 'not-applied' },
      error.suggestedNextAction
    )
  const failure = AppError.from(error)
  return new AppError(failure.code, failure.message, error, {
    ...failure.context,
    executionOutcome: 'not-applied',
  })
}

/** 跑写盘之前的一段（解析入参、定位、读记录）：同步、异步抛出的失败都补上「没有写入」的结论。 */
export async function beforeWrite<T>(task: () => Promise<T> | T): Promise<T> {
  try {
    return await task()
  } catch (error) {
    throw withNotAppliedOutcome(error)
  }
}

/** 把错误补上「没有写入」的结论后抛出（写盘开始之前的失败用）。 */
export function rethrowNotApplied(error: unknown): never {
  throw withNotAppliedOutcome(error)
}

/** 构造 BASE_REVISION_MISMATCH：文件或目标的 revision 已变化，带统一的「先重读再重做」建议。 */
export function revisionMismatch(message: string, details: any): ProjectError {
  return new ProjectError(
    'BASE_REVISION_MISMATCH',
    message,
    details,
    RevisionMismatchSuggestedNextAction
  )
}

/** 编辑失败后的回读建议：按 `velaros:project` 的 read 入参给（files 里一项，range 是 [首行,末行]），知道出错行时只读附近几行。 */
export function recoveryRead(path: string, line: Optional<number>) {
  const maxChars = ProjectTuning.transactions.recoveryReadMaxChars
  if (!line) return { read: { files: [{ path }], maxChars } }
  const range = [
    Math.max(1, line - ProjectTuning.transactions.recoveryReadLinesBefore),
    line + ProjectTuning.transactions.recoveryReadLinesAfter,
  ]
  return { read: { files: [{ path, range }], maxChars } }
}

/** 超过 maximum 个字符就截断并补一个省略号。 */
export function truncateText(text: string, maximum: number): string {
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text
}

/**
 * 把诊断压成对模型可读、可定位的信封：错误级排在最前、其中带行号的优先，只保留前 N 条（字段
 * 原样保留，仅截断超长 message），并生成「路径:行:列 消息（共 N 条）」的一行摘要放进错误
 * 消息——模型即使只看到 message 也知道去哪里改。完整 checks 与 diagnostics 重复且可能很大，
 * 不再随错误抛出。调用方保证至少有一条诊断。
 */
export function diagnosticsEnvelope(diagnostics: readonly Diagnostic[]): {
  headline: string
  details: { diagnostics: Diagnostic[]; diagnosticCount: number }
} {
  const rank = (diagnostic: Diagnostic): number =>
    (diagnostic.severity === 'error' ? 0 : 2) + (isPresent(diagnostic.line) ? 0 : 1)
  // 同一语法错误会被核心 adapter、TS 插件 adapter 与 validator 各报一次（只有 source 不同），
  // 按位置与消息去重后再计数，免得一个错误报成「共 3 条」并挤占前 N 条名额。
  const unique = [
    ...new Map(
      diagnostics.map((diagnostic) => [
        JSON.stringify([
          diagnostic.severity,
          diagnostic.path,
          diagnostic.line,
          diagnostic.column,
          diagnostic.message,
        ]),
        diagnostic,
      ])
    ).values(),
  ]
  // Array.prototype.sort 稳定：同档诊断保持 validator 产出顺序。
  const ordered = unique.sort((left, right) => rank(left) - rank(right))
  const [first] = ordered
  const location = [first.path, first.line, optionalWhen(isPresent(first.line), first.column)]
    .filter(isPresent)
    .join(':')
  const firstLine = truncateText(
    first.message.split('\n')[0].trim(),
    ProjectTuning.transactions.headlineChars
  )
  return {
    headline: `${isEmpty(location) ? '' : `${location} `}${firstLine}（共 ${ordered.length} 条）`,
    details: {
      diagnostics: ordered
        .slice(0, ProjectTuning.transactions.reportedDiagnostics)
        .map((diagnostic) => ({
          ...diagnostic,
          message: truncateText(
            diagnostic.message,
            ProjectTuning.transactions.diagnosticMessageChars
          ),
        })),
      diagnosticCount: ordered.length,
    },
  }
}

/**
 * `rebasedFiles` 出现表示失败发生在 apply 锁内的复核：准备事务后这些文件被外部修改，rebase 后
 * 的内容没通过校验。此时要改的不是编辑操作本身，而是先读最新内容。
 */
export function validationFailed(
  transactionId: string,
  validation: ValidationResult,
  context: { rebasedFiles?: string[] } = {}
): ProjectError {
  const failedChecks = [
    ...new Set(validation.checks.filter((check) => !check.ok).map((check) => check.id)),
  ]
  const envelope = diagnosticsEnvelope(
    !isEmpty(validation.diagnostics)
      ? validation.diagnostics
      : [
          {
            severity: 'error',
            message: !isEmpty(failedChecks)
              ? `检查未通过：${failedChecks.join('、')}`
              : '校验器返回未通过，未提供诊断详情。',
          },
        ]
  )
  const windows: Array<Record<string, unknown>> = []
  const diagnostics = envelope.details.diagnostics.map((diagnostic) => {
    if (!isPlainObject(diagnostic.data) || !isPlainObject(diagnostic.data.sourceContext))
      return diagnostic
    const { sourceContext, excerpt: _excerpt, ...data } = diagnostic.data
    windows.push({
      path: diagnostic.path,
      line: diagnostic.line,
      column: diagnostic.column,
      ...sourceContext,
    })
    return { ...diagnostic, data: { ...data, coordinateSpace: 'candidate' } }
  })
  return new ProjectError(
    'VALIDATION_FAILED',
    `改完的内容过不了校验，什么都没写：${envelope.headline}`,
    {
      transactionId,
      ...context,
      ...envelope.details,
      diagnostics,
      executionOutcome: 'not-applied',
      failedChecks,
      recovery: optionalWhen(!isEmpty(windows), {
        kind: 'project-edit-validation',
        coordinateSpace: 'candidate',
        applied: false,
        windows,
        note: 'windows 是尚未写入的候选源码预览，行号属于候选内容。检查错误附近和替换边界，照原文改好 oldText / newText 再提交。',
      }),
    },
    isPresent(context.rebasedFiles)
      ? '这些文件在准备改动之后被别处改了，合在一起过不了校验：先 read 看看现在的内容，再重新提交这次 edit。'
      : !isEmpty(windows)
        ? '按诊断与改完之后的预览改好再提交；预览里的行号是改完之后的。'
        : '按诊断改好再提交。'
  )
}
