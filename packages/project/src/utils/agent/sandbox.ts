/**
 * 演练沙箱在项目空间的辅助：取宿主的沙箱端口、把源目录限定在项目之内、按路径筛选变化、生成落回确认文案。
 */

import { isAbsolute, relative, resolve } from 'node:path'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProjectSandboxPort, ProjectToolContext } from '../../contract/requires.js'
import type { ProjectSandboxDiff } from '../../types/project.js'
import { ProjectTuning } from '../tuning.js'

/** 宿主没接沙箱端口时这个工具不可用，也不出现在工具面上。 */
export function requireSandboxPort(context: ProjectToolContext): ProjectSandboxPort {
  const port = context.project.sandbox
  if (!port) throw new AppError('UNAVAILABLE', '当前宿主没有接入演练沙箱。')
  return port
}

/** 把 source 解析成项目根之内的绝对路径；项目之外的目录拒绝，项目空间的沙箱只镜像项目。 */
export function resolveSourceInsideProject(rootPath: string, source: LooseOptional<string>): string {
  const resolved = resolve(rootPath, source ?? '.')
  const inside = relative(rootPath, resolved)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new AppError('VALIDATION', `沙箱的源目录必须在当前项目之内：${source ?? '.'}`)
  return resolved
}

/** 按调用方给的相对路径筛选三列；不给就全部。给了但三列里都没有的路径列在 unknown 里。 */
export function selectSandboxChanges(changes: ProjectSandboxDiff, paths: LooseOptional<readonly string[]>): { created: string[]; modified: string[]; deleted: string[]; unknown: string[] } {
  if (!paths || isEmpty(paths)) return { created: [...changes.created], modified: [...changes.modified], deleted: [...changes.deleted], unknown: [] }
  const wanted = new Set(paths.map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '')))
  const pick = (list: readonly string[]): string[] => list.filter((path) => wanted.has(path))
  const known = new Set([...changes.created, ...changes.modified, ...changes.deleted])
  return { created: pick(changes.created), modified: pick(changes.modified), deleted: pick(changes.deleted), unknown: [...wanted].filter((path) => !known.has(path)) }
}

/** 生成落回项目前给用户看的确认文案：三列的条数和前几条路径。 */
export function sandboxApplyConfirmationMessage(source: string, selection: { created: readonly string[]; modified: readonly string[]; deleted: readonly string[] }): string {
  const shown = ProjectTuning.sandbox.confirmationPreviewItems
  const preview = (list: readonly string[]): string => list.slice(0, shown).join('、') + (list.length > shown ? ` 等 ${list.length} 个` : '')
  const lines = [`即将把演练沙箱里的改动落回项目 ${source}：新增 ${selection.created.length} 个、覆盖 ${selection.modified.length} 个、删除 ${selection.deleted.length} 个文件。`]
  if (!isEmpty(selection.deleted)) lines.push(`删除：${preview(selection.deleted)}`)
  if (!isEmpty(selection.modified)) lines.push(`覆盖：${preview(selection.modified)}`)
  if (!isEmpty(selection.created)) lines.push(`新增：${preview(selection.created)}`)
  lines.push('删除和覆盖不经过 project:change 的撤销账本；落回前会核对这些文件自建沙箱以来没被别人改过，改过就整批不落。')
  return lines.join('\n')
}
