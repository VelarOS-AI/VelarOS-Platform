import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { isObject, isPresent } from '@velaros-ai/core'

import { ProjectError } from '../errors.js'
import type { ProjectTextEncoding } from '../types/text.js'
import { detectProjectTextEncoding, encodeProjectTextBuffer } from '../utils/text.js'

function isMissing(error: unknown): boolean {
  return isObject(error) && 'code' in error && error.code === 'ENOENT'
}

/** 调用方先执行根目录/权限校验；在同目录写完整临时文件再 rename，保留软链接及文件 mode。 */
export async function atomicWriteProjectText(
  path: string,
  content: string,
  fallback?: ProjectTextEncoding,
  fallbackMode?: number,
): Promise<void> {
  if (isPresent(fallbackMode) && (!Number.isInteger(fallbackMode) || fallbackMode < 0 || fallbackMode > 0o777)) {
    throw new ProjectError('INVALID_INPUT', '文件权限必须是 0 到 0777 的普通权限位。', { path })
  }
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
  const mode = existing ? existing.mode & 0o777 : fallbackMode
  const handle = await open(temporary, 'wx', mode ?? 0o666)
  try {
    // 已捕获的权限必须精确恢复；新文件的默认权限仍由 umask 收紧。
    if (isPresent(mode)) await handle.chmod(mode)
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
