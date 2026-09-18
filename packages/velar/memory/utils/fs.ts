/** 磁盘上的几个小动作：原子写、新建但不覆盖、判断文件在不在、列目录与读小文件、删文件；「不存在」按正常结果交回，别的错照常抛。 */

import { randomUUID } from 'node:crypto'
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'

import { readErrnoCode } from '@velaros-ai/core'

/** 原子地写一个文件：先写同目录的临时文件再改名，读的人要么看到旧的、要么看到新的，看不到半截。 */
export async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** 新建一个文件写进内容；已经有了就不动。 */
export async function writeFileIfMissing(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).catch((error: unknown) => {
    if (readErrnoCode(error) !== 'EEXIST') throw error
  })
}

/** 文件在不在：stat 不到（不存在、读不到）都算不在。 */
export async function fileExists(path: string): Promise<boolean> {
  return stat(path).then((stats) => stats.isFile(), () => false)
}

/** 列一个目录下的名字；目录还不存在时交回空的。 */
export async function readDirectoryNames(directory: string): Promise<string[]> {
  return readdir(directory).catch((error: unknown) => {
    if (readErrnoCode(error) === 'ENOENT') return []
    throw error
  })
}

/** 读一个小文本文件；不存在时交回 null。 */
export async function readTextIfExists(path: string): Promise<Nullable<string>> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (readErrnoCode(error) === 'ENOENT') return null
    throw error
  })
}

/** 删一个文件，交回删没删：本来就不存在时是 false。 */
export async function removeFileIfExists(path: string): Promise<boolean> {
  return rm(path).then(() => true, (error: unknown) => {
    if (readErrnoCode(error) === 'ENOENT') return false
    throw error
  })
}
