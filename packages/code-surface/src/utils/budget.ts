/** 回给模型之前的预算裁剪：日志与返回值都要在上限之内，裁了必须说。 */

import { isUndefined } from '@velaros-ai/core'

import { CodeSurfaceLimits } from '../contract/constants.js'
import type { CodeCallNotice } from '../types/code-surface.js'

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
