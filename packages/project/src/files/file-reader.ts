import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

import { isEmpty, isUndefined, mapDefined, optionalWhen } from '@velaros-ai/core'

import { ProjectError } from '../errors.js'
import type { ReadInput, ReadResult } from '../types/io.js'
import type { FileSnapshot } from '../types/snapshot.js'
import { detectProjectTextEncoding, type ProjectTextEncoding,ProjectTextEncodingProbe } from '../utils/text.js'

import { readProjectTextChunks } from './text-stream.js'

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

/** 按逻辑 UTF-8 字节数和 Unicode 字符数截断；CRLF 计一个换行，续读仍保存原始 UTF-16 offset。 */
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
  for (let offset = 0; offset < content.length;) {
    const crlf = content[offset] === '\r' && content[offset + 1] === '\n'
    const char = crlf ? '\n' : String.fromCodePoint(content.codePointAt(offset)!)
    const charUnits = crlf ? 2 : char.length
    const charBytes = encoder.encode(char).length
    if (charBounded && consumedCharacterCount + 1 > Math.max(0, maxChars!)) break
    if (byteBounded && consumedBytes + charBytes > Math.max(0, maxBytes!)) break
    consumedChars += charUnits
    consumedCharacterCount += 1
    consumedBytes += charBytes
    offset += charUnits
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

/** 列使用 UTF-16 坐标，但窗口边界必须落在完整 Unicode 字符之间。 */
function assertCharacterBoundary(text: string, offset: number, path: string, line: number): void {
  if (offset <= 0 || offset >= text.length) return
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
    throw new ProjectError('INVALID_INPUT', `${path}：第 ${line} 行列边界截断了 Unicode 字符。`,
      { path, line, column: offset + 1, characterColumns: [offset, offset + 2] },
      '请把列边界放在完整字符的前后，或按完整行读取。')
  }
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
  assertCharacterBoundary(firstLine, startColumn - 1, filePath, absoluteStartLine)
  assertCharacterBoundary(lastLine, endColumn - 1, filePath, absoluteEndLine)
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

/** 读取完整解码字符，最终预算由 limitContent 在统一 UTF-8/Unicode 视图上裁切。 */
export async function readLimitedTextPrefix(
  absPath: string,
  fileSize: number,
  limits: { maxBytes?: number; maxChars?: number },
  encoding?: ProjectTextEncoding,
): Promise<{ content: string; truncated: boolean }> {
  const parts: string[] = []
  let characters = 0
  let bytes = 0
  for await (const part of readProjectTextChunks(absPath, encoding)) {
    parts.push(part.content)
    if (!isUndefined(limits.maxChars)) characters += [...part.content.replace(/\r\n/g, '\n')].length
    if (!isUndefined(limits.maxBytes)) bytes += new TextEncoder().encode(part.content.replace(/\r\n/g, '\n')).length
    if ((!isUndefined(limits.maxChars) && characters > limits.maxChars) ||
        (!isUndefined(limits.maxBytes) && bytes > limits.maxBytes)) return { content: parts.join(''), truncated: part.byteOffset < fileSize }
  }
  return { content: parts.join(''), truncated: false }
}

/** 跳过窗口前的文本并增量收集目标行，内存与输出窗口而非文件前缀长度相关。 */
export async function readTextLineWindow(
  absPath: string,
  range: { startLine?: number; endLine?: number; startColumn?: number; endColumn?: number },
  limits: { maxBytes?: number; maxChars?: number } = {},
  encoding?: ProjectTextEncoding,
): Promise<LineWindowReadResult> {
  const startLine = Math.max(1, Math.floor(range.startLine ?? 1))
  const requestedEndLine = Math.max(startLine, range.endLine ?? Number.MAX_SAFE_INTEGER)
  const outputLimits = [limits.maxBytes, isUndefined(limits.maxChars) ? undefined : limits.maxChars * 2]
    .filter((value): value is number => !isUndefined(value))
  const outputLimit = isEmpty(outputLimits) ? Number.MAX_SAFE_INTEGER
    : Math.max(0, (range.startColumn ?? 1) - 1) + Math.min(...outputLimits) + 4
  const pieces: string[] = []
  let currentLine = 1
  let currentColumn = 1
  let outputLength = 0
  let hasMore = false
  let totalLines: Optional<number>
  outer: for await (const part of readProjectTextChunks(absPath, encoding)) {
    let from = 0
    while (from < part.content.length) {
      const newline = part.content.indexOf('\n', from)
      const end = newline < 0 ? part.content.length : newline
      if (currentLine >= startLine) {
        const text = part.content.slice(from, end)
        pieces.push(text)
        outputLength += text.length
        // 显式末列仍需读到能验证的位置，不能把预算截断的行当作真实文件末尾。
        const endColumnKnown = range.endLine !== currentLine || isUndefined(range.endColumn) ||
          currentColumn + text.length >= range.endColumn || newline >= 0
        if (outputLength >= outputLimit && endColumnKnown) { hasMore = true; break outer }
      }
      currentColumn += end - from
      if (newline < 0) break
      if (currentLine >= requestedEndLine) { hasMore = true; break outer }
      if (currentLine >= startLine) { pieces.push('\n'); outputLength += 1 }
      currentLine += 1
      currentColumn = 1
      from = newline + 1
    }
  }
  if (!hasMore) totalLines = currentLine
  const content = pieces.join('')
  return {
    content,
    range: { startLine, endLine: startLine + (content.match(/\n/g)?.length ?? 0) },
    hasMore,
    totalLines,
  }
}

export async function hashFileAndDetectBinary(
  absPath: string,
): Promise<{ hash: string; binary: boolean; textEncoding: Nullable<ProjectTextEncoding> }> {
  const handle = await open(absPath, 'r')
  const hash = createHash('sha256')
  const chunk = new Uint8Array(ReadPrefixChunkBytes)
  const probe = new ProjectTextEncodingProbe()

  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      const view = chunk.subarray(0, bytesRead)
      hash.update(view)
      probe.push(view)
    }
  } finally {
    await handle.close()
  }

  const textEncoding = probe.finish()
  return { hash: hash.digest('hex'), binary: !textEncoding, textEncoding }
}

/** metadata 模式下只读文件头部样本判定是否二进制，避免为算哈希整文件读取。 */
export async function detectBinaryByPrefix(absPath: string): Promise<boolean> {
  const handle = await open(absPath, 'r')
  try {
    const chunk = new Uint8Array(BinaryDetectionSampleBytes)
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
    return !detectProjectTextEncoding(chunk.subarray(0, bytesRead), bytesRead < Number((await handle.stat()).size))
  } finally {
    await handle.close()
  }
}
