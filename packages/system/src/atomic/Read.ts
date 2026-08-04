import { open } from 'node:fs/promises'

import { isEmpty,isNumber } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  decodeSystemTextBuffer,
  readErrnoCode,
  readSystemTextFile,
  resolveSystemPathInput,
} from './Filesystem.js'

const ReadLineWindowChunkBytes = 64 * 1024

/**
 * 把文本投影成用户可寻址的内容行。文件末尾的换行符只是最后一行的终止符，不能再制造一个
 * 空的“幽灵行”；中间连续换行产生的空行仍然保留。空文件维持一条空行，以兼容从第 1 行读取。
 */
interface AddressableTextLine {
  readonly content: string
  readonly terminator: string
}

function splitAddressableTextLines(content: string): AddressableTextLine[] {
  if (!content) return [{ content: '', terminator: '' }]
  const segments = content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? []
  return segments
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const terminator = segment.endsWith('\r\n')
        ? '\r\n'
        : segment.endsWith('\n')
          ? '\n'
          : segment.endsWith('\r')
            ? '\r'
            : ''
      return {
        content: terminator ? segment.slice(0, -terminator.length) : segment,
        terminator,
      }
    })
}

export interface AtomicReadInput {
  path: string
  startLine?: number
  endLine?: number
  maxChars?: number
}

export interface AtomicReadResult {
  path: string
  content: string
  totalLines?: number
  startLine: number
  endLine: number
  totalChars: number
  returnedChars: number
  truncated: boolean
  hasMore: boolean
  remainingLines?: number
  nextStartLine: Nullable<number>
}

export async function executeAtomicRead(input: AtomicReadInput): Promise<AtomicReadResult> {
  const resolvedPath = resolveSystemPathInput(input.path)
  const safeStartLine = input.startLine ? Math.max(1, input.startLine) : 1

  if (isNumber(input.endLine)) {
    if (safeStartLine > input.endLine) {
      throw new AppError(
        'VALIDATION',
        `Invalid range: startLine (${safeStartLine}) > endLine (${input.endLine})`
      )
    }

    const window = await readSystemTextLineWindow(resolvedPath, safeStartLine, input.endLine)
    return buildAtomicReadResult({
      path: resolvedPath,
      startLine: safeStartLine,
      requestedEndLine: input.endLine,
      lines: window.lines,
      hasMoreAfterWindow: window.hasMore,
      totalLines: window.totalLines,
      maxChars: input.maxChars,
    })
  }

  const textFile = await readSystemTextFile(resolvedPath)

  const fullContent = textFile.content
  const lines = splitAddressableTextLines(fullContent)
  const totalLines = lines.length
  const safeEndLine = input.endLine ? Math.min(totalLines, input.endLine) : totalLines

  if (safeStartLine > safeEndLine) {
    throw new AppError(
      'VALIDATION',
      `Invalid range: startLine (${safeStartLine}) > endLine (${safeEndLine})`
    )
  }

  const selectedLines = lines.slice(safeStartLine - 1, safeEndLine)
  return buildAtomicReadResult({
    path: resolvedPath,
    startLine: safeStartLine,
    requestedEndLine: safeEndLine,
    lines: selectedLines,
    hasMoreAfterWindow: safeEndLine < totalLines,
    totalLines,
    maxChars: input.maxChars,
  })
}

interface AtomicReadResultBuildInput {
  path: string
  startLine: number
  requestedEndLine: number
  lines: AddressableTextLine[]
  hasMoreAfterWindow: boolean
  totalLines?: number
  maxChars?: number
}

function buildAtomicReadResult(input: AtomicReadResultBuildInput): AtomicReadResult {
  if (isEmpty(input.lines) && isNumber(input.totalLines)) {
    const safeEndLine = Math.min(input.totalLines, input.requestedEndLine)
    if (input.startLine > safeEndLine) {
      throw new AppError(
        'VALIDATION',
        `Invalid range: startLine (${input.startLine}) > endLine (${safeEndLine})`
      )
    }
  }

  const selectedContent = input.lines
    .map((line) => `${line.content}${line.terminator}`)
    .join('')
  const totalChars = selectedContent.length
  const effectiveMaxChars = input.maxChars ?? totalChars
  const truncation = truncateAddressableLines(input.lines, effectiveMaxChars)
  const windowTruncated = totalChars > effectiveMaxChars
  const content = windowTruncated ? truncation.content : selectedContent
  const returnedLineCount = windowTruncated ? truncation.lineCount : input.lines.length
  const returnedEndLine = Math.max(input.startLine, input.startLine + returnedLineCount - 1)
  const hasMore = windowTruncated || input.hasMoreAfterWindow
  const nextStartLine = hasMore
    ? truncation.firstLineTruncated
      ? input.startLine
      : returnedEndLine + 1
    : null

  const result: AtomicReadResult = {
    path: input.path,
    content,
    startLine: input.startLine,
    endLine: returnedEndLine,
    totalChars,
    returnedChars: content.length,
    truncated: content.length < totalChars,
    hasMore,
    nextStartLine,
  }

  if (isNumber(input.totalLines)) {
    result.totalLines = input.totalLines
    result.remainingLines = hasMore ? Math.max(0, input.totalLines - returnedEndLine) : 0
  }

  return result
}

interface SystemTextLineWindow {
  lines: AddressableTextLine[]
  hasMore: boolean
  totalLines?: number
}

async function readSystemTextLineWindow(
  resolvedPath: string,
  startLine: number,
  endLine: number
): Promise<SystemTextLineWindow> {
  const handle = await openSystemTextFileForRead(resolvedPath)
  const chunk = Buffer.allocUnsafe(ReadLineWindowChunkBytes)
  const chunks: Buffer[] = []
  let reachedEof = false
  let window: SystemTextLineWindow = { lines: [], hasMore: false }

  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) {
        reachedEof = true
        break
      }

      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
      if (bytesRead < chunk.length) {
        reachedEof = true
        break
      }

      const decoded = decodeSystemTextBuffer(Buffer.concat(chunks), resolvedPath).content
      window = collectLineWindow(decoded, startLine, endLine, false)
      if (window.hasMore) break
    }

    if (reachedEof) {
      const decoded = decodeSystemTextBuffer(Buffer.concat(chunks), resolvedPath).content
      window = collectLineWindow(decoded, startLine, endLine, true)
    }
  } catch (err) {
    throw normalizeReadError(err, resolvedPath)
  } finally {
    await handle.close()
  }

  return window
}

function collectLineWindow(
  content: string,
  startLine: number,
  endLine: number,
  includeTrailingPartial: boolean
): SystemTextLineWindow {
  const parsedLines = splitAddressableTextLines(content)
  const lines = includeTrailingPartial
    ? parsedLines
    : parsedLines.filter((line) => !isEmpty(line.terminator))
  const selectedLines: AddressableTextLine[] = []
  let lineNumber = 1

  for (const line of lines) {
    if (lineNumber < startLine) {
      lineNumber += 1
      continue
    }

    if (lineNumber <= endLine) {
      selectedLines.push(line)
      lineNumber += 1
      continue
    }

    return {
      lines: selectedLines,
      hasMore: true,
      totalLines: includeTrailingPartial ? lines.length : undefined,
    }
  }

  return {
    lines: selectedLines,
    hasMore: false,
    totalLines: includeTrailingPartial ? lines.length : undefined,
  }
}

function truncateAddressableLines(
  lines: readonly AddressableTextLine[],
  maxChars: number
): { content: string; lineCount: number; firstLineTruncated: boolean } {
  let content = ''
  let lineCount = 0

  for (const line of lines) {
    const segment = `${line.content}${line.terminator}`
    if (content.length + segment.length > maxChars) {
      if (lineCount === 0) return {
          content: segment.slice(0, maxChars),
          lineCount: 1,
          firstLineTruncated: true,
        }
      return { content, lineCount, firstLineTruncated: false }
    }
    content += segment
    lineCount += 1
  }

  return { content, lineCount, firstLineTruncated: false }
}

async function openSystemTextFileForRead(resolvedPath: string) {
  try {
    return await open(resolvedPath, 'r')
  } catch (err) {
    throw normalizeReadError(err, resolvedPath)
  }
}

function normalizeReadError(err: unknown, resolvedPath: string): Error {
  if (err instanceof AppError) return err

  switch (readErrnoCode(err)) {
    case 'ENOENT':
      return new AppError('NOT_FOUND', `File not found: ${resolvedPath}`)
    case 'EACCES':
    case 'EPERM':
      return new AppError('PERMISSION', `Permission denied reading file: ${resolvedPath}`)
    case 'EISDIR':
      return new AppError('VALIDATION', `Path is a directory, not a file: ${resolvedPath}`)
    default:
      return err instanceof Error ? err : new AppError('UNKNOWN', String(err))
  }
}
