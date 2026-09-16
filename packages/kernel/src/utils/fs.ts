import { randomUUID } from 'node:crypto'
import {
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'

import { stringifyPretty } from '@velaros-ai/core'


export function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === code
}

export function ignoreMissing(error: unknown): void {
  if (!isNodeError(error, 'ENOENT')) throw error
}

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

/** Same-directory temp file plus rename so readers never observe a partial file. */
export async function writeJsonFileAtomic(
  path: string,
  value: unknown,
  mode = 0o600,
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
