/** 回给模型之前的预算裁剪：日志与返回值都要在上限之内，裁了必须说。 */

import { isUndefined } from '@velaros-ai/core'

import { CodeSurfaceLimits } from '../contract/constants.js'
import type { CodeCallNotice, CompletedCall } from '../types/code-surface.js'

import { keepTail } from './program.js'
import { CodeSurfaceTuning } from './tuning.js'

/** 日志按预算保留结尾，与 `system:run` 的输出窗口同口径：失败现场在尾部。单行太长的先各自截一刀，免得一行顶掉整份预算。 */
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

/** 返回值超预算时按结尾截断并说明；模型得知道自己看到的是一段而不是全部，否则它会拿半截数据当全部用。 */
export function fitValueToBudget(value: unknown, notices: CodeCallNotice[]): unknown {
  if (isUndefined(value)) return undefined
  const serialized = JSON.stringify(value) ?? 'null'
  if (serialized.length <= CodeSurfaceLimits.valueChars) return value
  const { text, dropped } = keepTail(serialized, CodeSurfaceLimits.valueChars)
  notices.push({
    call: 'return',
    action: 'truncated',
    detail: `返回值 ${serialized.length} 字符超过上限 ${CodeSurfaceLimits.valueChars}，前 ${dropped} 字符省略。下次在程序里先筛一遍再 return。`,
  })
  return text
}
