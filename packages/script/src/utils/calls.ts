/** 能力调用的账：落定的一次调用记成一笔，连着的同一件事折成一条。都不碰实例状态。 */

import { isArray, isPlainObject, isString, isUndefined } from '@velaros-ai/core'

import type { CodeCapabilityOutcome } from '../contract/requires.js'
import type { CompletedCall } from '../types/script.js'

/**
 * 落定的一次调用记成一笔。回执是个对象、带着字符串 changeRef 时（`velaros:project` 的 edit），连同它的 changedFiles 一起记下：
 * 撤这次改动凭它。别的回执内容不记——参数和回执可以很大，时间线只存操作的样子。
 */
export function settledCall(name: string, outcome: CodeCapabilityOutcome): CompletedCall {
  const entry: CompletedCall = { call: name, ok: isUndefined(outcome.error) }
  const value = outcome.value
  if (isPlainObject(value) && isString(value.changeRef)) {
    entry.changeRef = value.changeRef
    if (isArray(value.changedFiles)) entry.changedFiles = value.changedFiles.filter(isString)
  }
  return entry
}

/** 连着的同名同结果、都不带 changeRef 的几笔折成一条带 times；带 changeRef 的各记各的。 */
export function foldCalls(calls: readonly CompletedCall[]): CompletedCall[] {
  const folded: CompletedCall[] = []
  for (const entry of calls) {
    const last = folded.at(-1)
    const plain = isUndefined(entry.changeRef)
    if (
      last &&
      plain &&
      isUndefined(last.changeRef) &&
      last.call === entry.call &&
      last.ok === entry.ok
    ) {
      last.times = (last.times ?? 1) + 1
      continue
    }
    folded.push({ ...entry })
  }
  return folded
}
