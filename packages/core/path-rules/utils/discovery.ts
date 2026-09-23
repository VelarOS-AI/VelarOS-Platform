/**
 * 遍历前要问磁盘的两件事：往上找版本库根、读一份 .gitignore 的正文。
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** 从某个路径往上找最近的版本库根（有 `.git` 的那一级，工作树里的 `.git` 是文件也算）；找不到返回 null。 */
export async function findRepositoryRoot(startPath: string): Promise<Nullable<string>> {
  let current = resolve(startPath)
  const startStats = await stat(current).catch(() => null)
  if (startStats?.isFile()) current = dirname(current)

  while (true) {
    const marker = await stat(join(current, '.git')).catch(() => null)
    if (marker) return current

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** 读某个目录（规则根下的相对路径，根自己给空串）里那份 .gitignore 的正文；没有这个文件或读不了时返回空串。 */
export async function readGitignoreContent(
  rootPath: string,
  directoryRelativePath: string
): Promise<string> {
  // arch-guard:silent-catch-ok 缺少 .gitignore 或读取失败时按无规则处理。
  return readFile(join(rootPath, directoryRelativePath, '.gitignore'), 'utf8').catch(() => '')
}
