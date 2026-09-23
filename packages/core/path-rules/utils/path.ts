/**
 * 路径文本：规整成可比较的相对写法、算相对路径、列出从根到某个目录的各级目录。只算字符串，不碰磁盘。
 */

import { join, resolve } from 'node:path'

import { isNull } from '@velaros-ai/core'
import { currentPlatform } from '@velaros-ai/core/platform'

/** 规整一条相对路径：反斜杠换成 `/`，去掉开头的 `./`；末尾的 `/` 留着（规则以它表示「只匹配这个目录下面」）。 */
export function normalizeRelativePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 规整成用来比较的相对路径：同上，再去掉末尾的 `/`。 */
export function toComparableRelativePath(input: string): string {
  return normalizeRelativePath(input).replace(/\/$/, '')
}

/** 算出相对根的可移植路径（`/` 分隔，根本身是 `.`）；不在根里返回 null。大小写按字面比，解开符号链接是调用方的事。 */
export function relativeInsideRoot(rootPath: string, candidatePath: string): Nullable<string> {
  return currentPlatform.relativePathTextInside(candidatePath, rootPath, { caseSensitive: true })
}

/** 列出从根到某个目录之间的每一级目录（含两端），由浅到深；目录不在根里时返回空。 */
export function directoriesFromRootTo(rootPath: string, directoryPath: string): string[] {
  const relative = relativeInsideRoot(rootPath, directoryPath)
  if (isNull(relative)) return []
  const directories = [resolve(rootPath)]
  if (relative === '.') return directories
  for (const segment of relative.split('/')) directories.push(join(directories.at(-1)!, segment))
  return directories
}

/** 两条相对路径是不是同一条：按大小写规则比。 */
export function samePathText(target: string, value: string, caseSensitive: boolean): boolean {
  return caseSensitive ? target === value : target.toLowerCase() === value.toLowerCase()
}

/** 目标是不是落在某个目录之下（目录自己不算）：按大小写规则比。 */
export function isUnderPathText(
  target: string,
  directory: string,
  caseSensitive: boolean
): boolean {
  const prefix = `${directory}/`
  return caseSensitive
    ? target.startsWith(prefix)
    : target.toLowerCase().startsWith(prefix.toLowerCase())
}

/** 一条相对路径的各级上级目录，由深到浅（不含它自己）：`a/b/c` 给出 `a/b`、`a`。 */
export function ancestorRelativePaths(relativePath: string): string[] {
  const segments = toComparableRelativePath(relativePath).split('/').filter(Boolean)
  const ancestors: string[] = []
  for (let depth = segments.length - 1; depth > 0; depth -= 1)
    ancestors.push(segments.slice(0, depth).join('/'))
  return ancestors
}
