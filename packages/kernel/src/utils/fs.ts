import { randomUUID } from 'node:crypto'
import {
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'

import { stringifyPretty } from '@velaros-ai/core'

import { KernelFileModes } from '../contract/constants'


/** 判断一个错误是不是带指定 errno 码的 Node 文件系统错误。 */
export function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === code
}

/** 忽略「文件不存在」，别的错误照抛；给 `unlink`/`rm` 的 `.catch()` 用。 */
export function ignoreMissing(error: unknown): void {
  if (!isNodeError(error, 'ENOENT')) throw error
}

/** 读一个 JSON 文件；文件不在时返回 undefined，内容不是 JSON 时照抛。 */
export async function readJsonFile(path: string): Promise<unknown> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
  return JSON.parse(source) as unknown
}

/** 同目录临时文件加改名落盘：读的人永远看不到写了一半的文件。 */
export async function writeJsonFileAtomic(
  path: string,
  value: unknown,
  mode: number = KernelFileModes.privateFile,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(
      temporaryPath,
      `${stringifyPretty(value)}\n`,
      { encoding: 'utf8', mode },
    )
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}
