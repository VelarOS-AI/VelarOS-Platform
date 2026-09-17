/** 执行之前定下跑哪份源码、判体量，执行之后编成给模型看的结果。都不碰实例状态，所以不放在类里。 */

import { isEmpty, isNotUndefined, isUndefined } from '@velaros-ai/core'

import type { CodeSurfaceErrorCode } from '../contract/constants.js'
import { CodeSurfaceErrorCodes, CodeSurfaceLimits } from '../contract/constants.js'
import type {
  CodeCallNotice,
  CodeProgramFailure,
  CodeProgramRequest,
  CodeProgramResult,
  CompletedCall,
} from '../types/code-surface.js'
import type { CodeRunOutcome } from '../types/runner.js'

import { enforceResultBudget, fitFailureToBudget, fitJournalToBudget, fitLogsToBudget, fitNoticesToBudget, fitValueToBudget } from './budget.js'
import { applyProgramEdits } from './edit.js'
import { describeOversized } from './program.js'

/**
 * 定下这一轮到底跑哪份源码：整份重写就是它本身，传 `edits` 就在上一份上改。
 *
 * 两者只能给一个。传了 `edits` 却没有上一份时**明确拒绝，不猜一份出来**——
 * 猜错会把编辑落到别的程序上，那比直接说「重发整份」坏得多。
 */
export function resolveProgramSource(
  program: CodeProgramRequest,
  previousSource: Optional<string>
): { source: string } | { failed: CodeProgramFailure } {
  const fail = (message: string): { failed: CodeProgramFailure } => ({
    failed: { code: CodeSurfaceErrorCodes.editFailed, message },
  })
  const edits = program.edits
  const hasEdits = !isUndefined(edits) && edits.length > 0
  const hasSource = !isUndefined(program.source)

  if (!hasSource && !hasEdits) return fail('程序是空的：要么给 source 写一份新的，要么给 edits 在上一份上改。')
  if (hasSource && hasEdits) return fail('source 和 edits 只能给一个：要么整份重写，要么在上一份上改。')
  if (hasSource) return { source: program.source ?? '' }
  if (isUndefined(previousSource)) return fail('这一轮没有上一份程序可改（可能是新会话，或者上下文已经清过）。这次请用 source 发一份完整的。')

  const applied = applyProgramEdits(previousSource, edits ?? [])
  return 'failed' in applied ? fail(applied.failed) : { source: applied.source }
}

/** 体量超限一律拒，不截断后照跑——半截程序跑出来的结果比不跑更坏。没超返回 null。 */
export function describeProgramOversize(
  source: string,
  blobs: Optional<Readonly<Record<string, string>>>
): Nullable<string> {
  if (source.length > CodeSurfaceLimits.sourceChars) return describeOversized('source', source.length)
  const blobChars = Object.values(blobs ?? {}).reduce((sum, value) => sum + value.length, 0)
  return blobChars > CodeSurfaceLimits.blobChars ? describeOversized('blobs', blobChars) : null
}

/**
 * 编成给模型看的结果。
 *
 * 成功时 `value` 是主角，其余有才给；失败时主角换成 `failed` 与 `logs`——返回值没了，
 * 日志是唯一能说明「走到哪一步、拿到了什么」的东西。
 */
export function composeProgramResult(
  outcome: CodeRunOutcome,
  notices: CodeCallNotice[],
  completed: readonly CompletedCall[] = []
): CodeProgramResult {
  const result: CodeProgramResult = {}
  const logs = fitLogsToBudget(outcome.logs, notices)
  if (logs.length > 0) result.logs = logs

  if (outcome.ok) {
    const fitted = fitValueToBudget(outcome.value, notices)
    if (isNotUndefined(fitted)) result.value = fitted
  } else if (outcome.error) {
    const failed: CodeProgramFailure = {
      code: outcome.error.code as CodeSurfaceErrorCode,
      message: fitFailureToBudget(outcome.error.message),
    }
    if (isNotUndefined(outcome.error.line)) failed.line = outcome.error.line
    result.failed = failed
    // 账只在没跑完时给：跑完了模型自己知道调了什么，没跑完时它对着一个 ABORTED 什么都不知道。
    const journal = fitJournalToBudget(completed, notices)
    if (!isEmpty(journal)) result.completed = journal
  }

  // 插手记录最后收：上面几步自己也会往里记「我截了什么」。
  const fittedNotices = fitNoticesToBudget(notices)
  if (!isEmpty(fittedNotices)) result.notices = fittedNotices
  return enforceResultBudget(result)
}
