/**
 * 在上一份程序上改，而不是整份重写。
 *
 * typecheck 挡回去之后，模型今天得把整个程序重发一遍——六十行的程序每迭代一次就是六十行输出，
 * 还容易在别处改出新错。
 *
 * 协议：`oldText` 一字不差、在程序里唯一、全成或全不成、各处不许重叠。**不用行号，也不用字符位置**：
 * 模型看不见自己刚写的那段代码的行号与偏移，让它数是在让它做最不擅长的事；不唯一就多带几行上下文。
 */

import { isEmpty, isString } from '@velaros-ai/core'

import type { CodeProgramEdit } from '../types/code-surface.js'
import type { ResolvedProgramEdit } from '../types/editing.js'

/** 解一条编辑到字符区间；解不出来返回一句给模型看的话。 */
function resolveEdit(source: string, edit: CodeProgramEdit): ResolvedProgramEdit | string {
  if (!isString(edit.oldText) || isEmpty(edit.oldText)) return 'oldText 是空的，不知道改哪里：写上要换掉的那段原文。'
  const first = source.indexOf(edit.oldText)
  if (first < 0) return 'oldText 在上一份程序里找不到；它必须和原文的字符一模一样（含缩进与换行）。'
  if (source.includes(edit.oldText, first + 1)) return 'oldText 在程序里出现了不止一次，定不下来改哪一处。把 oldText 写长一点，带上前后几行。'
  return { start: first, end: first + edit.oldText.length, text: edit.newText }
}

/**
 * 把一组编辑落到上一份程序上。
 *
 * **全成或全不成**：任何一处解不出来就整份不动，并说清是第几处、为什么——半份改动跑出来的程序比不跑更坏。
 * 各处不许重叠，重叠说明模型对原文的判断已经错了，这时候硬落更危险。
 */
export function applyProgramEdits(
  previous: string,
  edits: readonly CodeProgramEdit[]
): { source: string } | { failed: string } {
  const resolved: ResolvedProgramEdit[] = []
  for (const [index, edit] of edits.entries()) {
    const result = resolveEdit(previous, edit)
    if (isString(result)) return { failed: `第 ${index + 1} 处改不了：${result}` }
    resolved.push(result)
  }

  const ordered = [...resolved].sort((left, right) => left.start - right.start)
  for (let index = 1; index < ordered.length; index += 1) {
    const earlier = ordered[index - 1]
    const current = ordered[index]
    if (earlier && current && current.start < earlier.end) return { failed: '两处改动落在同一段原文上，重叠了。把它们合成一处再发。' }
  }

  // 从后往前落：先改后面的，前面的偏移才不会被挪动。
  let source = previous
  for (const edit of [...ordered].reverse()) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  }
  return { source }
}
