import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { ToolContext } from '../Types.js'

import {
  encodeSystemTextContent,
  readSystemTextFile,
  resolveSystemPathInput,
  writeSystemFileAtomically,
} from './Filesystem.js'
import {
  assertAtomicWritePathOutsideActiveWorkspace,
  confirmSensitiveSystemMutation,
} from './WorkspaceBoundary.js'

export interface AtomicWriteInput {
  path: string
  content: string
  overwrite?: boolean
  maxBytes?: number
}

export interface AtomicWriteResult {
  path: string
  bytes: number
  created: boolean
  changed: boolean
}

export async function executeAtomicWrite(
  input: AtomicWriteInput,
  ctx: ToolContext
): Promise<AtomicWriteResult> {
  assertAtomicWritePathOutsideActiveWorkspace(input.path, ctx)
  const resolvedPath = resolveSystemPathInput(input.path)
  await confirmSensitiveSystemMutation(ctx, resolvedPath, 'write')
  const maxBytes = input.maxBytes ?? 1_000_000

  if (input.content.includes('\0')) {
    throw new AppError('VALIDATION', 'Content appears to contain binary data and cannot be written as text.')
  }

  const existing = await stat(resolvedPath).catch(() => null)
  if (existing?.isDirectory()) {
    throw new AppError('VALIDATION', `Path is a directory, not a file: ${resolvedPath}`)
  }

  const created = !existing
  // write 语义即「把内容写到这个路径」——覆盖已有文件默认放行(模型的显式意图,不是盲写:
  // 真正危险的系统/凭证路径由上面的 confirmSensitiveSystemMutation 走用户确认门,保内容的
  // 外科修改另有 edit 工具)。只在调用方显式传 overwrite=false(「仅创建」意图)时才拒绝已有文件。
  if (existing && input.overwrite === false) {
    throw new AppError(
      'VALIDATION',
      `File already exists and overwrite=false was set (create-only): ${resolvedPath}`
    )
  }

  const existingTextFile = existing?.isFile()
    ? await readSystemTextFile(resolvedPath).catch(() => null)
    : null
  const outputBuffer = encodeSystemTextContent(
    input.content,
    existingTextFile?.encoding ?? 'utf8'
  )
  const contentBytes = outputBuffer.byteLength
  if (contentBytes > maxBytes) {
    throw new AppError(
      'VALIDATION',
      `Content is too large for write: ${contentBytes} bytes > ${maxBytes} bytes`
    )
  }

  await mkdir(dirname(resolvedPath), { recursive: true })
  await writeSystemFileAtomically(resolvedPath, outputBuffer)

  return {
    path: resolvedPath,
    bytes: contentBytes,
    created,
    changed: created || existingTextFile?.content !== input.content,
  }
}
