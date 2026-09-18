/** 重放前后的核对：哪些文件不是该有的样子，以及怎么说给模型听。不碰实例状态。 */

import { isUndefined } from '@velaros-ai/core'

import type { ScriptFileChange } from '../types/code-surface.js'
import type { ReplayMismatch } from '../types/timeline.js'

import { shortHash } from './markers.js'
import { CodeSurfaceTuning } from './tuning.js'

/** 记一个对不上的文件：哪个、应当是什么、实际是什么（不存在的不给）。 */
function mismatchOf(path: string, expected: Optional<string>, actual: Optional<string>): ReplayMismatch {
  const mismatch: ReplayMismatch = { path }
  if (!isUndefined(expected)) mismatch.expected = expected
  if (!isUndefined(actual)) mismatch.actual = actual
  return mismatch
}

/** 跑之前：那一步当时改过的每个文件，现在得是当时改前的样子（当时不存在的，现在也得不存在）。 */
export function replayPreMismatches(expected: readonly ScriptFileChange[], current: ReadonlyMap<string, string>): ReplayMismatch[] {
  return expected
    .filter((change) => current.get(change.path) !== change.before)
    .map((change) => mismatchOf(change.path, change.before, current.get(change.path)))
}

/**
 * 跑之后：这一次改了哪些文件、改成什么样，得和当时一模一样——多改、少改、改得不一样都算对不上。
 * 这一次没动的文件按「还是改前的样子」算（跑之前核对过）。
 */
export function replayPostMismatches(expected: readonly ScriptFileChange[], actual: readonly ScriptFileChange[]): ReplayMismatch[] {
  const wanted = new Map(expected.map((change) => [change.path, change]))
  const made = new Map(actual.map((change) => [change.path, change]))
  const mismatches: ReplayMismatch[] = []
  for (const path of [...new Set([...wanted.keys(), ...made.keys()])].sort()) {
    const want = wanted.get(path)
    const got = made.get(path)
    const expectedAfter = want ? want.after : got?.before
    const actualAfter = got ? got.after : want?.before
    if (expectedAfter !== actualAfter) mismatches.push(mismatchOf(path, expectedAfter, actualAfter))
  }
  return mismatches
}

/** 对不上的文件写成给模型读的几行：开头一句说怎么回事，下面逐个文件「应当是 / 现在是」（哈希前八位），多了只列前几个。 */
export function describeReplayMismatch(lead: string, mismatches: readonly ReplayMismatch[]): string {
  const shown = mismatches.slice(0, CodeSurfaceTuning.replayMismatchLines).map((mismatch) => {
    const expected = isUndefined(mismatch.expected) ? '不存在' : `是 ${shortHash(mismatch.expected)}`
    const actual = isUndefined(mismatch.actual) ? '不存在' : `是 ${shortHash(mismatch.actual)}`
    return `  ${mismatch.path}：应当${expected}，现在${actual}`
  })
  const more = mismatches.length - shown.length
  return [lead, ...shown, ...(more > 0 ? [`  还有 ${more} 个文件没列出。`] : [])].join('\n')
}
