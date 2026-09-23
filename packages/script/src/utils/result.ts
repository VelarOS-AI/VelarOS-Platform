/** 执行之前判体量，执行之后编成给模型看的结果。都不碰实例状态，所以不放在类里。 */

import { isEmpty, isNotUndefined, isPlainObject, isUndefined } from '@velaros-ai/core'

import type { CodeSurfaceErrorCode } from '../contract/constants.js'
import { CodeSurfaceLimits } from '../contract/constants.js'
import type { CodeRunOutcome } from '../types/runner.js'
import type {
  CodeCallNotice,
  CodeProgramFailure,
  CodeProgramResult,
  CompletedCall,
} from '../types/script.js'

import {
  enforceResultBudget,
  fitFailureToBudget,
  fitJournalToBudget,
  fitLogsToBudget,
  fitNoticesToBudget,
  fitValueToBudget,
} from './budget.js'
import { describeOversized } from './program.js'

/** 体量超限一律拒，不截断后照跑——半截程序跑出来的结果比不跑更坏。blobs 与 input（按 JSON 算）合在一起算。没超返回 null。 */
export function describeProgramOversize(
  source: string,
  blobs: Optional<Readonly<Record<string, string>>>,
  input?: unknown
): Nullable<string> {
  if (source.length > CodeSurfaceLimits.sourceChars)
    return describeOversized('source', source.length)
  const blobChars = Object.values(blobs ?? {}).reduce((sum, value) => sum + value.length, 0)
  const inputChars = isUndefined(input) ? 0 : (JSON.stringify(input) ?? '').length
  return blobChars + inputChars > CodeSurfaceLimits.blobChars
    ? describeOversized('blobs', blobChars + inputChars)
    : null
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
  completed: readonly CompletedCall[] = [],
  unsettled: readonly string[] = [],
  named = false
): CodeProgramResult {
  const result: CodeProgramResult = {}
  // 程序停下时还没落定的调用：跑完了也可能有（发出去没 await），副作用可能做了一半，一律列出。
  if (!isEmpty(unsettled)) result.unsettled = [...unsettled]
  const logs = fitLogsToBudget(outcome.logs, notices)
  if (logs.length > 0) result.logs = logs

  if (outcome.ok) {
    const fitted = fitValueToBudget(outcome.value, notices)
    if (isNotUndefined(fitted)) result.value = fitted
    if (named && isPlainObject(fitted)) result.named = true
  } else if (outcome.error) {
    const failed: CodeProgramFailure = {
      code: outcome.error.code as CodeSurfaceErrorCode,
      message: fitFailureToBudget(outcome.error.message),
    }
    if (isNotUndefined(outcome.error.line)) failed.line = outcome.error.line
    result.failed = failed
    // 程序正是死在这次拒绝上的：failed 已经说了，notices 里同一句不再重复。
    const repeated = notices.findIndex(
      (notice) => notice.action === 'denied' && notice.detail === outcome.error!.message
    )
    if (repeated >= 0) notices.splice(repeated, 1)
    // 账只在没跑完时给：跑完了模型自己知道调了什么，没跑完时它对着一个 ABORTED 什么都不知道。
    const journal = fitJournalToBudget(completed, notices)
    if (!isEmpty(journal)) result.completed = journal
  }

  // 插手记录最后收：上面几步自己也会往里记「我截了什么」。
  const fittedNotices = fitNoticesToBudget(notices)
  if (!isEmpty(fittedNotices)) result.notices = fittedNotices
  return enforceResultBudget(result)
}
