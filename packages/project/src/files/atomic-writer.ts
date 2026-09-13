import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ProjectError } from '../errors.js'
import type { ProjectTextEncoding } from '../types/text.js'
import { detectProjectTextEncoding, encodeProjectTextBuffer } from '../utils/text.js'

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** 调用方先执行根目录/权限校验；在同目录写完整临时文件再 rename，保留软链接及文件 mode。 */
export async function atomicWriteProjectText(
  path: string,
  content: string,
  fallback?: ProjectTextEncoding,
): Promise<void> {
  const entry = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
  const target = entry?.isSymbolicLink() ? await realpath(path) : path
  const existing = entry?.isSymbolicLink() ? await lstat(target) : entry
  if (existing && (!existing.isFile() || existing.nlink > 1)) {
    throw new ProjectError(
      'NOT_SUPPORTED',
      '原子文本写入需要普通文件或指向普通文件的软链接；多硬链接文件需要独立处理。',
      { path },
    )
  }
  const bytes = existing ? await readFile(target) : undefined
  const encoding = bytes ? (detectProjectTextEncoding(bytes) ?? fallback) : fallback
  // 编码失败必须发生在创建临时文件之前；编码异常不能降级为 UTF-8。
  const encoded = encodeProjectTextBuffer(content, encoding)
  const temporary = join(dirname(target), `.velaros-write-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', existing ? existing.mode & 0o777 : 0o666)
  try {
    if (existing) await handle.chmod(existing.mode & 0o777)
    await handle.writeFile(encoded)
    await handle.sync()
    await handle.close()
    await rename(temporary, target)
    if (process.platform !== 'win32') {
      const directory = await open(dirname(target), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await handle.close()
    await rm(temporary, { force: true })
  }
}
