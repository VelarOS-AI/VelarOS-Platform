/**
 * 文件系统错误：读出 Node 错误码，把读文件时的系统错误翻成对应的错误码。
 */

import { isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/** 读出 Node 文件系统错误的错误码字符串，如 ENOENT；认不出返回 null。 */
export function readErrnoCode(error: unknown): Nullable<string> {
  if (!isPlainObject(error)) return null
  return isString(error.code) ? error.code : null
}

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
