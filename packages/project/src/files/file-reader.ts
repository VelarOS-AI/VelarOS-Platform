import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

import { isEmpty, isNull, isUndefined, mapDefined, optionalWhen } from '@velaros-ai/core'

import { ProjectError } from '../errors.js'
import type { ReadInput, ReadResult } from '../types/io.js'
import type { FileSnapshot } from '../types/snapshot.js'
import { decodeProjectTextBuffer, isProbablyBinary } from '../utils/text.js'

export const ReadPrefixChunkBytes = 64 * 1024

export const BinaryDetectionSampleBytes = 8000

/** 文本切片以及继续有界读取所需的元数据。 */
export interface ByteLimitedContent {
  content: string
  truncated: boolean
  lineCount: number
  /** 从原始输入消费的 UTF-16 code units；可能包含为保持完整行而省略的末尾换行。 */
  consumedChars: number
}

export interface LineWindowReadResult {
  content: string
  range: { startLine: number; endLine: number }
  hasMore: boolean
  /** 只有读到文件末尾时才确定的总行数，计数口径与内存路径一致（按 \n 切分）。 */
  totalLines?: number
}

/** 按 UTF-8 字节数和 Unicode 字符数截断，优先保留完整行，并记录精确 UTF-16 续读 offset。 */
export function limitContent(
  content: string,
  maxBytes?: number,
  maxChars?: number,
): ByteLimitedContent {
  const byteBounded = !isUndefined(maxBytes)
  const charBounded = !isUndefined(maxChars)
  if (!byteBounded && !charBounded)
    return {
      content,
      truncated: false,
      lineCount: countTextLines(content),
      consumedChars: content.length,
    }

  const encoder = new TextEncoder()
  let consumedChars = 0
  let consumedCharacterCount = 0
  let consumedBytes = 0
  for (const char of content) {
    const charUnits = char.length
    const charBytes = encoder.encode(char).length
    if (charBounded && consumedCharacterCount + 1 > Math.max(0, maxChars!)) break
    if (byteBounded && consumedBytes + charBytes > Math.max(0, maxBytes!)) break
    consumedChars += charUnits
    consumedCharacterCount += 1
    consumedBytes += charBytes
  }
  if (
    consumedChars === 0 &&
    !isEmpty(content) &&
    byteBounded &&
    maxBytes! > 0 &&
    (!charBounded || maxChars! > 0)
  ) {
    throw new ProjectError(
      'INVALID_INPUT',
      'maxBytes 小于下一个完整 UTF-8 字符所需字节数',
      { maxBytes },
      '请提高 maxBytes 后重试；读取不会返回半个 UTF-8 字符。',
    )
  }

  if (consumedChars >= content.length)
    return {
      content,
      truncated: false,
      lineCount: countTextLines(content),
      consumedChars: content.length,
    }

  const exactPrefix = content.slice(0, consumedChars)
  const lastNewline = exactPrefix.lastIndexOf('\n')
  if (lastNewline >= 0) {
    const completeLines = content.slice(0, lastNewline + 1)
    return {
      content: completeLines,
      truncated: true,
      lineCount: countTextLines(completeLines),
      consumedChars: lastNewline + 1,
    }
  }
  return {
    content: exactPrefix,
    truncated: true,
    lineCount: countTextLines(exactPrefix),
    consumedChars,
  }
}

export function estimateTokensFromBytes(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / 4))
}

export function countTextLines(content: string): number {
  if (isEmpty(content)) return 0
  const newlineMatches = content.match(/\n/g)?.length ?? 0
  return content.endsWith('\n') ? newlineMatches : newlineMatches + 1
}

export interface ReadCursor {
  line: number
  column: number
}

/**
 * 起始行越界不是调用错误：同一个 range 常被套用到一批长短不一的文件上，短文件越界时返回
 * 空内容与总行数并说明原因，批量里的其它文件照常推进。
 */
export function readPastEnd(
  snapshot: FileSnapshot,
  startLine: number,
  totalLines: number,
): ReadResult {
  return {
    snapshot,
    content: '',
    totalLines,
    truncated: false,
    hasMore: false,
    note: `文件共 ${totalLines} 行，请求的起始行 ${startLine} 超出范围，未返回内容；如需文件末尾，请把 startLine 设为不大于 ${totalLines} 的值。`,
  }
}

/**
 * endLine 超出总行数时已按文件末尾钳制；此时 endColumn 失去参照行，只能忽略并说明。
 * 流式窗口没读到文件末尾时总行数未知，但那也说明 endLine 没有越界。
 */
export function endColumnClampNote(
  range: NonNullable<ReadInput['range']>,
  totalLines: Optional<number>,
): Optional<string> {
  if (
    isUndefined(totalLines) ||
    isUndefined(range.endColumn) ||
    isUndefined(range.endLine) ||
    range.endLine <= totalLines
  )
    return undefined
  return `endLine ${range.endLine} 超出文件总行数 ${totalLines}，已读到文件末尾并忽略 endColumn。`
}

export function sliceWindowColumns(
  filePath: string,
  content: string,
  range: ReadInput['range'],
  absoluteStartLine: number,
  absoluteEndLine: number,
): {
  content: string
  startColumn: number
  endColumn: number
  hasMoreOnEndLine: boolean
} {
  const lines = content.split('\n')
  const firstLine = lines[0] ?? ''
  const lastLine = lines.at(-1) ?? ''
  const startColumn = range?.startColumn ?? 1
  const endColumn =
    range?.endLine === absoluteEndLine
      ? (range.endColumn ?? lastLine.length + 1)
      : lastLine.length + 1
  if (startColumn > firstLine.length + 1) {
    throw new ProjectError(
      'INVALID_INPUT',
      `${filePath}：startColumn ${startColumn} 超出第 ${absoluteStartLine} 行长度 ${firstLine.length}`,
      { path: filePath, range, lineLength: firstLine.length },
    )
  }
  if (endColumn > lastLine.length + 1) {
    throw new ProjectError(
      'INVALID_INPUT',
      `${filePath}：endColumn ${endColumn} 超出第 ${absoluteEndLine} 行长度 ${lastLine.length}`,
      { path: filePath, range, lineLength: lastLine.length },
    )
  }
  if (lines.length === 1) {
    if (endColumn < startColumn) {
      throw new ProjectError(
        'INVALID_INPUT',
        `${filePath}：同一行的 endColumn 不能早于 startColumn`,
        { path: filePath, range },
      )
    }
    return {
      content: firstLine.slice(startColumn - 1, endColumn - 1),
      startColumn,
      endColumn,
      hasMoreOnEndLine: endColumn < firstLine.length + 1,
    }
  }
  const selected = [
    firstLine.slice(startColumn - 1),
    ...lines.slice(1, -1),
    lastLine.slice(0, endColumn - 1),
  ].join('\n')
  return {
    content: selected,
    startColumn,
    endColumn,
    hasMoreOnEndLine: endColumn < lastLine.length + 1,
  }
}

export function advanceReadCursor(start: ReadCursor, consumed: string): ReadCursor {
  const lastNewline = consumed.lastIndexOf('\n')
  if (lastNewline === -1) return { line: start.line, column: start.column + consumed.length }
  const newlineCount = consumed.match(/\n/g)?.length ?? 0
  return {
    line: start.line + newlineCount,
    column: consumed.length - lastNewline,
  }
}

export function continuationInput(
  input: ReadInput,
  pathValue: string,
  revision: string,
  cursor: ReadCursor,
  preserveRequestedEnd: boolean,
): ReadInput {
  return {
    path: pathValue,
    baseRevision: revision,
    range: {
      startLine: cursor.line,
      startColumn: optionalWhen(cursor.column > 1, cursor.column),
      endLine: optionalWhen(preserveRequestedEnd, input.range?.endLine),
      endColumn: optionalWhen(preserveRequestedEnd, input.range?.endColumn),
    },
    maxBytes: input.maxBytes,
    maxChars: mapDefined(input.maxChars, (maxChars) => Math.max(1, maxChars)),
    trust: input.trust,
  }
}

export function concatByteChunks(chunks: readonly Uint8Array[]): Buffer {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return Buffer.from(combined)
}

export async function readLimitedTextPrefix(
  absPath: string,
  fileSize: number,
  limits: { maxBytes?: number; maxChars?: number },
): Promise<{ content: string; truncated: boolean }> {
  const handle = await open(absPath, 'r')
  const chunk = new Uint8Array(ReadPrefixChunkBytes)
  const chunks: Buffer[] = []
  let bytesReadTotal = 0
  let reachedEof = false
  let decodedContent: Nullable<string> = ''

  try {
    while (true) {
      const decoded = !isEmpty(chunks) ? decodeProjectTextBuffer(concatByteChunks(chunks)) : ''
      const remainingChars = !isUndefined(limits.maxChars)
        ? Math.max(0, limits.maxChars - [...(decoded ?? '')].length)
        : undefined
      const charByteBudget = !isUndefined(remainingChars)
        ? remainingChars * 4 + 4
        : ReadPrefixChunkBytes
      const remainingBytes = !isUndefined(limits.maxBytes)
        ? Math.min(limits.maxBytes - bytesReadTotal, charByteBudget)
        : charByteBudget
      if (remainingBytes <= 0) break
      const readSize = Math.min(chunk.length, remainingBytes)
      const { bytesRead } = await handle.read(chunk, 0, readSize, null)
      if (bytesRead === 0) {
        reachedEof = true
        break
      }

      bytesReadTotal += bytesRead
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
      const content = decodeProjectTextBuffer(concatByteChunks(chunks)) ?? ''
      if (!isUndefined(limits.maxChars) && [...content].length >= limits.maxChars) {
        break
      }
      if (!isUndefined(limits.maxBytes) && bytesReadTotal >= limits.maxBytes) break
    }

    decodedContent = !isEmpty(chunks) ? decodeProjectTextBuffer(concatByteChunks(chunks)) : ''
    let lookaheadBytes = 0
    while (
      (isNull(decodedContent) || (isEmpty(decodedContent) && bytesReadTotal < fileSize)) &&
      bytesReadTotal < fileSize &&
      lookaheadBytes < 8
    ) {
      const { bytesRead } = await handle.read(chunk, 0, 1, null)
      if (bytesRead === 0) {
        reachedEof = true
        break
      }
      bytesReadTotal += bytesRead
      lookaheadBytes += bytesRead
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
      decodedContent = decodeProjectTextBuffer(concatByteChunks(chunks))
    }
  } finally {
    await handle.close()
  }

  if (isNull(decodedContent)) {
    throw new ProjectError(
      'INVALID_INPUT',
      '读取预算无法覆盖下一个完整文本字符',
      { maxBytes: limits.maxBytes, maxChars: limits.maxChars },
      '请提高 maxBytes 或 maxChars 后重试；读取不会返回无法解码的字符片段。',
    )
  }
  return {
    content: decodedContent,
    truncated: !reachedEof && bytesReadTotal < fileSize,
  }
}

export async function readTextLineWindow(
  absPath: string,
  range: {
    startLine?: number
    endLine?: number
    startColumn?: number
    endColumn?: number
  },
  limits: { maxBytes?: number; maxChars?: number } = {},
): Promise<LineWindowReadResult> {
  const startLine = Math.max(1, Math.floor(range.startLine ?? 1))
  const requestedEndLine = Math.max(
    startLine,
    Number.isFinite(range.endLine)
      ? Math.floor(range.endLine ?? startLine)
      : Number.MAX_SAFE_INTEGER,
  )
  const handle = await open(absPath, 'r')
  const chunk = new Uint8Array(ReadPrefixChunkBytes)
  const lines: string[] = []
  const chunks: Buffer[] = []
  let currentLine = 1
  let hasMore = false
  let totalLines: Optional<number>
  const outputLimitCandidates = [limits.maxBytes, limits.maxChars].filter(
    (value): value is number => !isUndefined(value),
  )
  const outputLimit = !isEmpty(outputLimitCandidates)
    ? Math.min(...outputLimitCandidates)
    : undefined

  const acceptLine = (line: string) => {
    if (currentLine < startLine) {
      currentLine++
      return false
    }
    if (currentLine <= requestedEndLine) {
      lines.push(line)
      currentLine++
      return false
    }
    hasMore = true
    return true
  }

  try {
    while (!hasMore) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break

      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
      const decoded = decodeProjectTextBuffer(concatByteChunks(chunks)) ?? ''
      const parts = decoded.split('\n')
      if (!isUndefined(outputLimit) && parts.length >= startLine) {
        const lastRequestedPart = Math.min(parts.length, requestedEndLine)
        const partialWindow = parts.slice(startLine - 1, lastRequestedPart).join('\n')
        const requiredChars = Math.max(0, (range.startColumn ?? 1) - 1) + outputLimit + 1
        if (partialWindow.length >= requiredChars) {
          lines.length = 0
          lines.push(...partialWindow.split('\n'))
          hasMore = true
          break
        }
      }
      const completeParts = decoded.endsWith('\n') ? parts : parts.slice(0, -1)
      currentLine = 1
      lines.length = 0
      for (const line of completeParts) {
        if (acceptLine(line)) break
      }
    }

    if (!hasMore) {
      const decoded = decodeProjectTextBuffer(concatByteChunks(chunks)) ?? ''
      const parts = decoded.split('\n')
      totalLines = parts.length
      currentLine = 1
      lines.length = 0
      for (const line of parts) {
        if (acceptLine(line)) break
      }
    }
  } finally {
    await handle.close()
  }

  return {
    content: lines.join('\n'),
    range: {
      startLine,
      endLine: Math.max(startLine, startLine + lines.length - 1),
    },
    hasMore,
    totalLines,
  }
}

export async function hashFileAndDetectBinary(
  absPath: string,
): Promise<{ hash: string; binary: boolean }> {
  const handle = await open(absPath, 'r')
  const hash = createHash('sha256')
  const chunk = new Uint8Array(ReadPrefixChunkBytes)
  let binarySample: Uint8Array | undefined

  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      const view = chunk.subarray(0, bytesRead)
      hash.update(view)
      if (!binarySample) {
        binarySample = view.slice(0, BinaryDetectionSampleBytes)
      }
    }
  } finally {
    await handle.close()
  }

  return {
    hash: hash.digest('hex'),
    binary: isProbablyBinary(binarySample ?? new Uint8Array()),
  }
}

/** metadata 模式下只读文件头部样本判定是否二进制，避免为算哈希整文件读取。 */
export async function detectBinaryByPrefix(absPath: string): Promise<boolean> {
  const handle = await open(absPath, 'r')
  try {
    const chunk = new Uint8Array(BinaryDetectionSampleBytes)
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
    return isProbablyBinary(chunk.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}
