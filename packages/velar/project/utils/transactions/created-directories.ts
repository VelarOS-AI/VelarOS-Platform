/**
 * 事务新建的目录：apply 之前记下这次会顺带建出来的空目录，撤销时从深到浅把仍然空着的删掉，撤销后不留下半截目录树。
 * 记下来的目录跟着事务的 metadata 落进事务状态文件，跨进程重启后撤销照样能清。
 */

import { rmdir } from 'node:fs/promises'

/** 一条根相对路径的各级父目录，从浅到深（`lib/deep/new.txt` → `lib`、`lib/deep`）；根目录本身不算。 */
export function ancestorDirectories(relativePath: string): string[] {
  const segments = relativePath.split('/').filter((segment) => segment && segment !== '.')
  const directories: string[] = []
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join('/'))
  }
  return directories
}

/**
 * 这批路径写下去之前，哪些父目录还不存在：按从浅到深去重，逐个问 `exists`。
 * 它们就是这次 apply 会新建的目录（等同于 `mkdir --recursive` 实际建出来的那几级）。
 */
export async function missingAncestorDirectories(
  paths: readonly string[],
  exists: (directory: string) => Promise<boolean>,
): Promise<string[]> {
  const candidates = new Set<string>()
  for (const path of paths) for (const directory of ancestorDirectories(path)) candidates.add(directory)
  const missing: string[] = []
  for (const directory of [...candidates].sort((left, right) => left.length - right.length)) {
    if (!(await exists(directory))) missing.push(directory)
  }
  return missing
}

/**
 * 从深到浅删掉仍然空着的目录：`rmdir` 天生只删空目录，非空（ENOTEMPTY）、已经不在（ENOENT）都跳过。
 * `resolve` 要把根相对路径过一遍项目的写入授权再给出绝对路径，越界或不许写的目录一个都不碰。
 */
export async function removeEmptyDirectories(
  directories: readonly string[],
  resolve: (directory: string) => Promise<string>,
): Promise<string[]> {
  const removed: string[] = []
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(await resolve(directory))
      removed.push(directory)
    } catch {
      // arch-guard:silent-catch-ok 目录还有别的东西、已经不在、或者现在不许写，都当作没这一步。
      continue
    }
  }
  return removed
}
