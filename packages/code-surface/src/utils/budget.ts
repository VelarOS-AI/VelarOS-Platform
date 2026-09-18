/** 回给模型之前的预算裁剪：日志与返回值都要在上限之内，裁了必须说。 */

import { isString, isUndefined } from '@velaros-ai/core'

import { CodeSurfaceLimits } from '../contract/constants.js'
import type { CodeAttachment, CodeCallNotice, CodeProgramCheckFailure, CodeProgramDiagnostic, CodeProgramResult, CompletedCall } from '../types/code-surface.js'

import { keepTail } from './program.js'
import { CodeSurfaceTuning } from './tuning.js'

/** 日志按预算保留结尾，与 `velar:shell` 的 run 回执同口径：失败现场在尾部。单行太长的先各自截一刀，免得一行顶掉整份预算。 */
export function fitLogsToBudget(logs: readonly string[], notices: CodeCallNotice[]): string[] {
  const clipped = logs.map((line) =>
    line.length > CodeSurfaceTuning.logLineChars ? `${line.slice(0, CodeSurfaceTuning.logLineChars)}…` : line
  )
  const { text, dropped } = keepTail(clipped.join('\n'), CodeSurfaceLimits.logChars)
  if (dropped > 0) {
    notices.push({
      call: 'console.log',
      action: 'truncated',
      detail: `日志超过预算，前 ${dropped} 字符省略，保留结尾。`,
    })
  }
  return text.length === 0 ? [] : text.split('\n')
}

/**
 * 执行账按预算收拢：连着的同名同结果折成一条带 `times`，还是太长就保留结尾并说明。
 *
 * 保留结尾与日志同口径：中断现场在尾部，「最后做成的是哪件」比「第一件是哪件」有用得多。
 */
export function fitJournalToBudget(
  completed: readonly CompletedCall[],
  notices: CodeCallNotice[]
): CompletedCall[] {
  const folded: CompletedCall[] = []
  for (const entry of completed) {
    const last = folded.at(-1)
    if (isUndefined(last) || last.call !== entry.call || last.ok !== entry.ok) {
      folded.push({ call: entry.call, ok: entry.ok })
      continue
    }
    last.times = (last.times ?? 1) + 1
  }

  if (folded.length <= CodeSurfaceTuning.journalEntries) return folded
  const dropped = folded.length - CodeSurfaceTuning.journalEntries
  notices.push({
    call: 'program',
    action: 'truncated',
    detail: `执行账有 ${folded.length} 条，只列最后 ${CodeSurfaceTuning.journalEntries} 条，前 ${dropped} 条省略。`,
  })
  return folded.slice(dropped)
}

/**
 * 导出的值超预算时按结尾截断并说明；模型得知道自己看到的是一段而不是全部，否则它会拿半截数据当全部用。
 * 字符串按原文截（它原样交给模型），别的按 JSON 截。
 */
export function fitValueToBudget(value: unknown, notices: CodeCallNotice[]): unknown {
  if (isUndefined(value)) return undefined
  const text = isString(value) ? value : JSON.stringify(value) ?? 'null'
  if (text.length <= CodeSurfaceLimits.valueChars) return value
  const kept = keepTail(text, CodeSurfaceLimits.valueChars)
  notices.push({
    call: 'export',
    action: 'truncated',
    detail: `导出的值 ${text.length} 字符超过上限 ${CodeSurfaceLimits.valueChars}，前 ${kept.dropped} 字符省略。下次在程序里先看大小、筛好了再导出。`,
  })
  return kept.text
}

/**
 * 失败说明按预算保留**开头**：报错的要紧话在第一行（`TypeError: x is not a function`），
 * 而程序完全可以 `throw new Error(整个文件)`——不截，「正文不进上下文」就被错误通道走私进来了。
 */
export function fitFailureToBudget(message: string): string {
  if (message.length <= CodeSurfaceLimits.failureChars) return message
  const dropped = message.length - CodeSurfaceLimits.failureChars
  return `${message.slice(0, CodeSurfaceLimits.failureChars)}…后面 ${dropped} 字符省略（别把大段内容塞进错误里，要看的东西 console.log 一小段或者 export default）`
}

/**
 * 插手记录按预算收拢：连着的同一件事折成一条，单条说明截短，总量超了只留开头并说明省了几条。
 *
 * 留**开头**而不是结尾：插手记录里最早的那几条通常就是原因（第一次被拒、第一次被钳），
 * 后面多半是同一个原因反复触发。
 */
export function fitNoticesToBudget(notices: readonly CodeCallNotice[]): CodeCallNotice[] {
  const folded: Array<CodeCallNotice & { repeated: number }> = []
  for (const notice of notices) {
    const detail = notice.detail.length > CodeSurfaceTuning.noticeDetailChars
      ? `${notice.detail.slice(0, CodeSurfaceTuning.noticeDetailChars)}…`
      : notice.detail
    const last = folded.at(-1)
    if (last && last.call === notice.call && last.action === notice.action && last.field === notice.field && last.detail === detail) {
      last.repeated += 1
      continue
    }
    folded.push({ ...notice, detail, repeated: 1 })
  }

  const kept: CodeCallNotice[] = []
  let used = 0
  for (const [index, { repeated, ...notice }] of folded.entries()) {
    const shaped = repeated > 1 ? { ...notice, detail: `${notice.detail}（连着 ${repeated} 次）` } : notice
    const cost = JSON.stringify(shaped).length
    if (used + cost > CodeSurfaceLimits.noticeChars) {
      kept.push({ call: 'program', action: 'truncated', detail: `还有 ${folded.length - index} 条插手记录省略。` })
      break
    }
    kept.push(shaped)
    used += cost
  }
  return kept
}

/** 诊断按条数与总量收拢，单条先截短：一条类型错的说明可以把整个展开的类型打出来。 */
export function fitDiagnosticsToBudget(diagnostics: readonly CodeProgramDiagnostic[]): {
  diagnostics: CodeProgramDiagnostic[]
  omitted: number
} {
  const kept: CodeProgramDiagnostic[] = []
  let used = 0
  for (const diagnostic of diagnostics.slice(0, CodeSurfaceLimits.diagnostics)) {
    const message = diagnostic.message.length > CodeSurfaceTuning.diagnosticMessageChars
      ? `${diagnostic.message.slice(0, CodeSurfaceTuning.diagnosticMessageChars)}…`
      : diagnostic.message
    const shaped = { ...diagnostic, message }
    const cost = JSON.stringify(shaped).length
    if (used + cost > CodeSurfaceLimits.diagnosticChars) break
    kept.push(shaped)
    used += cost
  }
  return { diagnostics: kept, omitted: diagnostics.length - kept.length }
}

/**
 * 交给模型的图按张数与体积收拢：超出的**按顺序丢后面的**，并说明丢了几张。
 *
 * 张数上限对齐 API「一个请求超过 20 张，每张都得 ≤ 2000 px」那条线；体积上限给请求体里的历史留地方。
 * 丢后面的而不是前面的：程序是按它想看的顺序交的，前面的通常是它最想看的。
 */
export function fitAttachmentsToBudget(attachments: readonly CodeAttachment[], notices: CodeCallNotice[]): CodeAttachment[] {
  const kept: CodeAttachment[] = []
  let used = 0
  for (const attachment of attachments) {
    if (kept.length >= CodeSurfaceLimits.images || used + attachment.data.length > CodeSurfaceLimits.imageChars) break
    kept.push(attachment)
    used += attachment.data.length
  }
  if (kept.length < attachments.length) {
    notices.push({
      call: 'program',
      action: 'truncated',
      detail: `这次程序交了 ${attachments.length} 张图，只给了前 ${kept.length} 张（一次最多 ${CodeSurfaceLimits.images} 张）。剩下的分几次程序看，看完一张先记下要点再看下一张。`,
    })
  }
  return kept
}

/** 检查没过时回给模型的那份：诊断收拢到预算里，省了几条就说几条。 */
export function rejectWithDiagnostics(all: readonly CodeProgramDiagnostic[]): CodeProgramCheckFailure {
  const { diagnostics, omitted } = fitDiagnosticsToBudget(all)
  const failure: CodeProgramCheckFailure = { ok: false, diagnostics }
  if (omitted > 0) failure.omitted = omitted
  return failure
}

/**
 * 最后一道硬闸：整份结果序列化之后仍然超过总上限，就按「最不要紧的先让」逐项拿掉。
 *
 * 各通道都有自己的上限，正常情况下走不到这里；它存在是为了**将来**——
 * 哪条通道加了新东西、忘了设上限，回到模型那里的仍然不超过这个数。
 */
export function enforceResultBudget(result: CodeProgramResult): CodeProgramResult {
  const fits = (candidate: CodeProgramResult): boolean => JSON.stringify(candidate).length <= CodeSurfaceLimits.resultChars
  if (fits(result)) return result
  const dropped = (what: string): CodeCallNotice[] => [{
    call: 'program',
    action: 'truncated',
    detail: `结果超过 ${CodeSurfaceLimits.resultChars} 字符的总上限，${what}已省略。`,
  }]

  // 让的顺序：执行账 → 日志 → 插手记录 → 返回值。失败说明与失败码永远留着：没有它模型连发生了什么都不知道。
  const withoutJournal: CodeProgramResult = { ...result, notices: dropped('执行账') }
  withoutJournal.completed = undefined
  if (fits(withoutJournal)) return withoutJournal

  const withoutLogs: CodeProgramResult = { ...withoutJournal, notices: dropped('执行账与日志') }
  withoutLogs.logs = undefined
  if (fits(withoutLogs)) return withoutLogs

  const shrunk: CodeProgramResult = { ...withoutLogs, notices: dropped('执行账、日志与大半个返回值') }
  shrunk.value = keepTail(JSON.stringify(result.value) ?? 'null', CodeSurfaceLimits.valueChars / 2).text
  return shrunk
}
