/** 磁盘上的几个小动作：原子写、新建但不覆盖、列目录与读小文件、删文件；「不存在」按正常结果交回，别的错照常抛。 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

import { Log, readErrnoCode } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/** 原子地写一个文件：先写同目录的临时文件再改名，读的人要么看到旧的、要么看到新的，看不到半截。 */
export async function writeFileAtomically(
  path: string,
  content: string,
  signal?: AbortSignal
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    signal?.throwIfAborted()
    await writeFile(temporary, content, 'utf8')
    signal?.throwIfAborted()
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch((error: unknown) => {
      Log.tag('MemoryFile').warn('temporary cleanup failed', { error })
    })
  }
}

/** 新建一个文件写进内容；已经有了就不动。 */
export async function writeFileIfMissing(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }).catch((error: unknown) => {
    if (readErrnoCode(error) !== 'EEXIST') throw error
  })
}

/** 列一个目录下的名字；目录还不存在时交回空的。 */
export async function readDirectoryNames(directory: string): Promise<string[]> {
  return readdir(directory).catch((error: unknown) => {
    if (readErrnoCode(error) === 'ENOENT') return []
    throw error
  })
}

/** 只列一个目录下的子目录名，普通文件不算；目录还不存在时交回空的。 */
export async function readSubdirectoryNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (readErrnoCode(error) === 'ENOENT') return []
    throw error
  })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
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
  return rm(path).then(
    () => true,
    (error: unknown) => {
      if (readErrnoCode(error) === 'ENOENT') return false
      throw error
    }
  )
}

/** 同一磁盘条目的跨实例/进程互斥；冲突立即返回，调用方重读后重试，不自动夺取可能仍活跃的锁。 */
export async function withMemoryWriteLock<T>(
  path: string,
  action: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted()
  const lock = `${path}.lock`
  try {
    await mkdir(lock)
  } catch (error) {
    if (readErrnoCode(error) === 'EEXIST')
      throw new AppError(
        'CONFLICT',
        '这条记忆正在被修改，或先前进程留下了写锁；确认写者状态后重读并重试'
      )
    throw error
  }
  try {
    signal?.throwIfAborted()
    return await action()
  } finally {
    await rm(lock, { recursive: true, force: true }).catch((error: unknown) => {
      Log.tag('MemoryFile').warn('write lock cleanup failed', { error })
    })
  }
}
