/** 落回前的纯函数：按路径筛三列。 */

import { isEmpty } from '@velaros-ai/core'

import type { SandboxSelection } from '../types/rehearsal-sandbox.js'

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
