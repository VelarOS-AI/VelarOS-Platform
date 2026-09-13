import { isEmpty, isPresent, optionalWhen } from '@velaros-ai/core'

import { ProjectError } from '../errors.js'
import type { Diagnostic } from '../types/common.js'
import type { ValidationResult } from '../types/validation.js'

const RevisionMismatchSuggestedNextAction =
  '请重新读取受影响文件，并使用最新 snapshot.revision 重试。'

// 失败信封只携带模型定位问题所需的诊断：前几条足以指路，其余只报总数。
const MaxReportedDiagnostics = 10
// 命令型 validator 会把整段 stdout/stderr 塞进一条诊断，信封里按字符截断。
const MaxDiagnosticMessageChars = 2000
const MaxHeadlineChars = 200

export function revisionMismatch(message: string, details: any): ProjectError {
  return new ProjectError(
    'BASE_REVISION_MISMATCH',
    message,
    details,
    RevisionMismatchSuggestedNextAction,
  )
}

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
      ]),
    ).values(),
  ]
  // Array.prototype.sort 稳定：同档诊断保持 validator 产出顺序。
  const ordered = unique.sort((left, right) => rank(left) - rank(right))
  const [first] = ordered
  const location = [first.path, first.line, optionalWhen(isPresent(first.line), first.column)]
    .filter(isPresent)
    .join(':')
  const firstLine = truncateText(first.message.split('\n')[0].trim(), MaxHeadlineChars)
  return {
    headline: `${isEmpty(location) ? '' : `${location} `}${firstLine}（共 ${ordered.length} 条）`,
    details: {
      diagnostics: ordered.slice(0, MaxReportedDiagnostics).map((diagnostic) => ({
        ...diagnostic,
        message: truncateText(diagnostic.message, MaxDiagnosticMessageChars),
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
  context: { rebasedFiles?: string[] } = {},
): ProjectError {
  const envelope = diagnosticsEnvelope(validation.diagnostics)
  return new ProjectError(
    'VALIDATION_FAILED',
    `事务校验失败，未写入磁盘：${envelope.headline}`,
    {
      transactionId,
      ...context,
      ...envelope.details,
      failedChecks: [
        ...new Set(validation.checks.filter((check) => !check.ok).map((check) => check.id)),
      ],
    },
    isPresent(context.rebasedFiles)
      ? '准备事务后 rebasedFiles 被外部修改，rebase 后的内容未通过校验；请重新读取这些文件，基于最新内容重新准备事务。'
      : '请根据 diagnostics 修正编辑操作，然后重新准备事务。',
  )
}
