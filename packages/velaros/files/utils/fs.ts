/**
 * 文件系统：把读文件时的系统错误翻成对应的错误码，本机文件端口的原子写入与核对之后删除。
 */

import { unlink } from 'node:fs/promises'

import { readErrnoCode } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { textFileIo } from '@velaros-ai/core/text-files'
import type { ExpectedBytes } from '@velaros-ai/core/text-files/contracts'
import { TextFileErrorCodes } from '@velaros-ai/core/text-files/contracts'

/** 把读文件时的系统错误翻成对应的错误码；已经是 AppError 的原样返回。 */
export function normalizeReadError(err: unknown, path: string): Error {
  if (err instanceof AppError) return err
  switch (readErrnoCode(err)) {
    case 'ENOENT':
      return new AppError('NOT_FOUND', `文件不存在：${path}`)
    case 'EACCES':
    case 'EPERM':
      return new AppError('PERMISSION', `没有权限读这个文件：${path}`)
    case 'EISDIR':
      return new AppError('VALIDATION', `路径是目录，不是文件：${path}`)
    default:
      return err instanceof Error ? err : new AppError('UNKNOWN', String(err))
  }
}

/**
 * 原子地替换文件的全部字节（公共件 text-files：同目录临时文件写完 fsync 再改名，已有文件的权限位精确保留，新文件的权限由 umask 定）；
 * 给了 expected 时写前、改名前各核对一次磁盘上还是不是那份字节，对不上就什么都不写——核对完版本到真正落盘之间也有人会改；
 * 没有写权限时报权限错误；有多个硬链接或不是普通文件的路径拒写，说明改用 run。
 */
export async function writeFileAtomically(
  resolvedPath: string,
  contentBuffer: Buffer,
  expected?: ExpectedBytes
): Promise<void> {
  try {
    await textFileIo.writeBytes(resolvedPath, contentBuffer, expected ? { expected } : {})
  } catch (err) {
    const code = readErrnoCode(err)
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AppError('PERMISSION', `没有权限写这个文件：${resolvedPath}`)
    }
    if (err instanceof AppError && err.code === TextFileErrorCodes.externalEdit) {
      throw new AppError(
        'VALIDATION',
        `写的时候 ${resolvedPath} 被别人改了，这个文件什么都没写；重新 read 一遍再改`
      )
    }
    if (err instanceof AppError && err.code === TextFileErrorCodes.notRegular) {
      throw new AppError(
        'VALIDATION',
        `不能原子替换这个文件：${resolvedPath}。它有多个硬链接（替换后会和其余链接分家）或不是普通文件；确实要改就用 run`
      )
    }
    throw err
  }
}

/**
 * 删掉一个文件（撤回一次新建时用）：给了 expected 就先核对磁盘上还是那份字节，对不上（含文件已经不在）就不删、报 VALIDATION——
 * 核对完到删之间有人改了也不会误删他的内容，只剩一个极短的窗口；没给 expected 时文件已经不在算做完。没有权限时报权限错误。
 */
export async function removeFileChecked(
  resolvedPath: string,
  expected?: ExpectedBytes
): Promise<void> {
  try {
    if (expected) await textFileIo.assertUnchanged(resolvedPath, expected)
    await unlink(resolvedPath)
  } catch (err) {
    const code = readErrnoCode(err)
    if (code === 'ENOENT') return
    if (code === 'EACCES' || code === 'EPERM')
      throw new AppError('PERMISSION', `没有权限删这个文件：${resolvedPath}`)
    if (err instanceof AppError && err.code === TextFileErrorCodes.externalEdit) {
      throw new AppError(
        'VALIDATION',
        `删的时候 ${resolvedPath} 被别人改了，没删；重新 read 一遍再决定`
      )
    }
    throw err
  }
}
