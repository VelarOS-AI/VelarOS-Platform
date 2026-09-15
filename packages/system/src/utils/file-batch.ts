/**
 * 读和看都是一批文件：核对一批的条数，造失败条目。
 */

import { AppError } from '@velaros-ai/core/error'

import type { SystemFileFailure } from '../contract/files.js'

/** 一批最多几个文件：空的和超过 max 个的都拒绝，operation 只用来写进报错。 */
export function assertFileBatchSize(count: number, max: number, operation: string): void {
  if (count < 1) throw new AppError('VALIDATION', `files is empty; give at least one file to ${operation}`)
  if (count > max) throw new AppError('VALIDATION', `At most ${max} files per ${operation}; got ${count}, split the list`)
}

/** 一批里某个文件失败时的条目：路径照传入的原样，错误只留代码和说明。 */
export function failureEntry(path: string, failure: AppError): SystemFileFailure {
  return { path, error: { code: failure.code, message: failure.message } }
}
