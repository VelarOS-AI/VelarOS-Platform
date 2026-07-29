import { AppError } from '@velaros-ai/core/error'

import type { ToolContext } from '../Types.js'

import {
  adaptReplacementLineEndings,
  countOccurrences,
  encodeSystemTextContent,
  readSystemTextFile,
  resolveSystemPathInput,
  writeSystemFileAtomically,
} from './Filesystem.js'
import {
  assertAtomicWritePathOutsideActiveWorkspace,
  confirmSensitiveSystemMutation,
} from './WorkspaceBoundary.js'

export interface AtomicEditInput {
  path: string
  oldText: string
  newText: string
  expectedReplacements?: number
  maxFileBytes?: number
}

export interface AtomicEditResult {
  path: string
  replacements: number
  beforeBytes: number
  afterBytes: number
  changed: boolean
}

export async function executeAtomicEdit(
  input: AtomicEditInput,
  ctx: ToolContext
): Promise<AtomicEditResult> {
  assertAtomicWritePathOutsideActiveWorkspace(input.path, ctx)
  const resolvedPath = resolveSystemPathInput(input.path)
  await confirmSensitiveSystemMutation(ctx, resolvedPath, 'edit')
  const textFile = await readSystemTextFile(resolvedPath)
  const expectedReplacementCount = input.expectedReplacements ?? 1
  const maxEditableBytes = input.maxFileBytes ?? 500_000

  if (textFile.buffer.byteLength > maxEditableBytes) {
    throw new AppError(
      'VALIDATION',
      `File is too large for edit: ${textFile.buffer.byteLength} bytes > ${maxEditableBytes} bytes`
    )
  }

  const fullContent = textFile.content
  const replacement = adaptReplacementLineEndings(fullContent, input.oldText, input.newText)
  const replacements = countOccurrences(fullContent, replacement.oldText)
  if (replacements === 0) {
    throw new AppError('NOT_FOUND', `oldText was not found in file: ${resolvedPath}`)
  }
  if (replacements !== expectedReplacementCount) {
    throw new AppError(
      'VALIDATION',
      `Expected ${expectedReplacementCount} replacement(s), found ${replacements} in file: ${resolvedPath}`
    )
  }

  const updatedContent = fullContent
    .split(replacement.oldText)
    .join(replacement.newText)
  const updatedBuffer = encodeSystemTextContent(updatedContent, textFile.encoding)
  await writeSystemFileAtomically(resolvedPath, updatedBuffer)

  return {
    path: resolvedPath,
    replacements,
    beforeBytes: textFile.buffer.byteLength,
    afterBytes: updatedBuffer.byteLength,
    changed: updatedContent !== fullContent,
  }
}
