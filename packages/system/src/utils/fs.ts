/**
 * 文件系统：读取错误码、原子写入文件。
 */

import { stat } from 'node:fs/promises'

import { isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { writeFileAtomically } from '@velaros-ai/core/utils/FilePersistence'


/** 读出 Node 文件系统错误的错误码字符串，如 ENOENT；认不出返回 null。 */
export function readErrnoCode(error: unknown): Nullable<string> {
  if (!isPlainObject(error)) return null
  return isString(error.code) ? error.code : null
}

/** 原子地写入文件，保留已有文件的权限位；没有写权限时报权限错误。 */
export async function writeSystemFileAtomically(
  resolvedPath: string,
  contentBuffer: Buffer
): Promise<void> {
  const existing = await stat(resolvedPath).catch(() => null)
  const mode = existing?.isFile() ? existing.mode & 0o777 : 0o644

  try {
    await writeFileAtomically(resolvedPath, contentBuffer, { mode })
  } catch (err) {
    const code = readErrnoCode(err)
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AppError('PERMISSION', `Permission denied writing file: ${resolvedPath}`)
    }
    throw err
  }
}
