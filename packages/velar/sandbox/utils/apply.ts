/** 落回前的纯函数：按路径筛三列、生成确认文案。 */

import { isEmpty } from '@velaros-ai/core'

import type { SandboxSelection } from '../types/rehearsal-sandbox.js'

import { RehearsalSandboxTuning } from './tuning.js'

/** 把点名的路径规整成差量里的写法：反斜杠换成 /，去掉开头的 ./。 */
export function normalizeSandboxPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 按点名的相对路径筛三列；不点名就全部。点名了、三列里都没有的路径放进 unknown。 */
export function selectSandboxChanges(
  changes: { created: readonly string[]; modified: readonly string[]; deleted: readonly string[] },
  paths: LooseOptional<readonly string[]>,
): SandboxSelection {
  if (!paths || isEmpty(paths)) return { created: [...changes.created], modified: [...changes.modified], deleted: [...changes.deleted], unknown: [] }
  const wanted = new Set(paths.map(normalizeSandboxPath))
  const pick = (list: readonly string[]): string[] => list.filter((path) => wanted.has(path))
  const known = new Set([...changes.created, ...changes.modified, ...changes.deleted])
  return { created: pick(changes.created), modified: pick(changes.modified), deleted: pick(changes.deleted), unknown: [...wanted].filter((path) => !known.has(path)) }
}

/** 一列路径的预览：前几条用顿号连起来，多出来的只报总数。 */
export function previewSandboxPaths(list: readonly string[]): string {
  const shown = RehearsalSandboxTuning.confirmation.previewItems
  return list.slice(0, shown).join('、') + (list.length > shown ? ` 等 ${list.length} 个` : '')
}

/** 落回确认文案：落回哪儿、三列的条数与预览（删除、覆盖在前）、要点名的敏感路径，最后是空间自己的提醒。 */
export function buildSandboxApplyConfirmationMessage(
  targetLabel: string,
  selection: Pick<SandboxSelection, 'created' | 'modified' | 'deleted'>,
  sensitivePaths: readonly string[],
  closingNote: string,
): string {
  const lines = [`即将把演练沙箱里的改动落回 ${targetLabel}：新增 ${selection.created.length} 个、覆盖 ${selection.modified.length} 个、删除 ${selection.deleted.length} 个文件。`]
  if (!isEmpty(selection.deleted)) lines.push(`删除：${previewSandboxPaths(selection.deleted)}`)
  if (!isEmpty(selection.modified)) lines.push(`覆盖：${previewSandboxPaths(selection.modified)}`)
  if (!isEmpty(selection.created)) lines.push(`新增：${previewSandboxPaths(selection.created)}`)
  if (!isEmpty(sensitivePaths)) lines.push(`其中是系统敏感路径或凭证文件的：${previewSandboxPaths(sensitivePaths)}`)
  lines.push(closingNote)
  return lines.join('\n')
}
