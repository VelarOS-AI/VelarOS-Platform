/**
 * 在上一份程序上改，而不是整份重写。
 *
 * typecheck 挡回去之后，模型今天得把整个程序重发一遍——六十行的程序每迭代一次就是六十行输出，
 * 还容易在别处改出新错。
 *
 * 协议：`oldText` 一字不差、范围里必须唯一、全成或全不成、各处不许重叠。**不用行号**：
 * 模型看不见自己刚写的那段代码的行号，让它数行是在让它做最不擅长的事。
 * 这里的程序是模型刚写的，没有回执可抄，所以 `oldText` 是主键、`range` 只是可选的收窄手段。
 */

import { isString, isUndefined } from '@velaros-ai/core'

import type { CodeProgramEdit } from '../types/code-surface.js'
import type { ResolvedProgramEdit } from '../types/editing.js'

/** 解一条编辑到字符区间；解不出来返回一句给模型看的话。 */
function resolveEdit(source: string, edit: CodeProgramEdit): ResolvedProgramEdit | string {
  const within = isUndefined(edit.range)
    ? { start: 0, end: source.length }
    : { start: edit.range.offset, end: edit.range.end }
  if (within.start < 0 || within.end > source.length || within.start > within.end) return `range 超出了上一份程序（它一共 ${source.length} 个字符）。range 可以不给，不给就在整份程序里找 oldText。`

  if (isUndefined(edit.oldText)) {
    if (isUndefined(edit.range)) return '这一处既没给 oldText 也没给 range，不知道改哪里。一般写 oldText 就够了。'
    // 不给 oldText 就把整段换掉；空区间是在那个位置插入。与 system:edit 同义。
    return { start: within.start, end: within.end, text: edit.newText }
  }

  const slice = source.slice(within.start, within.end)
  const first = slice.indexOf(edit.oldText)
  if (first < 0) return 'oldText 在上一份程序里找不到；它必须和原文的字符一模一样（含缩进与换行）。'
  if (slice.includes(edit.oldText, first + 1)) return 'oldText 在范围里出现了不止一次，定不下来改哪一处。把 oldText 写长一点带上前后文，或者用 range 收窄。'
  return { start: within.start + first, end: within.start + first + edit.oldText.length, text: edit.newText }
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
