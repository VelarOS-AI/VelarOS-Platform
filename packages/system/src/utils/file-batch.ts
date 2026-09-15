/**
 * 读、看、写都是一批文件：核对一批的条数，造读和看的失败条目，造写的整批失败。
 */

import { isPresent, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { SystemEditFailureDetails, SystemEditFileResult, SystemEditProblem, SystemFileFailure } from '../contract/files.js'
import { SystemErrorCodes } from '../contract/system.js'

/** 一批最多几个文件：空的和超过 max 个的都拒绝，operation 只用来写进报错。 */
export function assertFileBatchSize(count: number, max: number, operation: string): void {
  if (count < 1) throw new AppError('VALIDATION', `files is empty; give at least one file to ${operation}`)
  if (count > max) throw new AppError('VALIDATION', `At most ${max} files per ${operation}; got ${count}, split the list`)
}

/** 一批里某个文件失败时的条目：路径照传入的原样，错误只留代码和说明。 */
export function failureEntry(path: string, failure: AppError): SystemFileFailure {
  return { path, error: { code: failure.code, message: failure.message } }
}

/** 一批里最多放进回执的问题数：Agent 边界的失败回执每个数组只保留 10 项。 */
const MaxReportedProblems = 10

/**
 * edit 整批定不下来时抛的错误：什么都没写。problems 放在 cause 的 details 里让 Agent 边界原样交给模型，
 * context 里标 executionOutcome 为 not-applied，模型就能用 reuse + changes 只改出问题的那一处再发一次。
 */
export function unresolvedEditFailure(problems: readonly SystemEditProblem[]): AppError {
  const denied = problems.some((problem) => problem.reason === 'denied')
  const summary = problems.slice(0, MaxReportedProblems).map((problem) => `files[${problem.file}]${isPresent(problem.edit) ? `.edits[${problem.edit}]` : ''}: ${problem.message}`).join('; ')
  const details: SystemEditFailureDetails = { executionOutcome: 'not-applied', problems: problems.slice(0, MaxReportedProblems) }
  const cause = {
    reason: denied ? SystemErrorCodes.editDenied : SystemErrorCodes.editUnresolved,
    details,
    suggestedNextAction: 'Nothing was written. Fix only the listed places with reuse + changes (for example path ["files", 0, "edits", 1, "range"] set to the chosen anchor range) and call system:edit again; unchanged files and edits are kept as they were.',
  }
  return new AppError(denied ? 'PERMISSION' : problems.every((problem) => problem.reason === 'not-found') ? 'NOT_FOUND' : 'VALIDATION', `${problems.length} problem(s) kept the edit from being applied; nothing was written. ${summary}`, cause, { executionOutcome: 'not-applied' })
}

/** 核对调用方给的版本和文件现在的版本：给了且对不上就返回一条 stale 问题的字段，其余情况返回 null。文件不存在时当前版本为 null。 */
export function staleProblem(expected: Optional<string>, current: Nullable<string>): Nullable<Pick<SystemEditProblem, 'reason' | 'message' | 'currentVersion'>> {
  if (!isPresent(expected) || expected === current) return null
  return {
    reason: 'stale',
    message: current
      ? `the file changed since version ${expected}; it is now ${current}, read it again before editing`
      : `version ${expected} was given but the file does not exist`,
    currentVersion: toOptional(current),
  }
}

/** 路径是符号链接时把真正被写的目标记进结果；不是链接就原样返回。 */
export function withLinkTarget<T extends SystemEditFileResult>(result: T, path: string, target: string): T {
  if (target !== path) result.target = target
  return result
}
