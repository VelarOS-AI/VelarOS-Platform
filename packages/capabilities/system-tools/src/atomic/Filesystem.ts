import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { writeFileAtomically } from '@velaros-ai/core/utils/FilePersistence'

import { systemPlatformCompatibility } from '../SystemPlatformCompatibility'

const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF])
const UTF16LE_BOM = Buffer.from([0xFF, 0xFE])
const UTF16BE_BOM = Buffer.from([0xFE, 0xFF])

export type SystemTextEncoding =
  | 'utf8'
  | 'utf8-bom'
  | 'utf16le'
  | 'utf16be'
  | 'utf16le-nobom'
  | 'utf16be-nobom'

export interface SystemTextFileContent {
  buffer: Buffer
  content: string
  encoding: SystemTextEncoding
}

export function resolveSystemPathInput(path: string): string {
  const normalizedPath = systemPlatformCompatibility.normalizeUserPathInput(path, homedir())
  return isAbsolute(normalizedPath) ? resolve(normalizedPath) : resolve(homedir(), normalizedPath)
}

export async function readSystemTextFile(resolvedPath: string): Promise<SystemTextFileContent> {
  const buffer = await readRawSystemFileBuffer(resolvedPath)
  const decoded = decodeSystemTextBuffer(buffer, resolvedPath)
  return {
    buffer,
    ...decoded,
  }
}

export async function readSystemTextFileBuffer(resolvedPath: string): Promise<Buffer> {
  const contentBuffer = await readRawSystemFileBuffer(resolvedPath)
  decodeSystemTextBuffer(contentBuffer, resolvedPath)
  return contentBuffer
}

export async function writeSystemFileAtomically(
  resolvedPath: string,
  contentBuffer: Buffer
): Promise<void> {
  const existing = await stat(resolvedPath).catch(() => null)
  const mode = existing?.isFile() ? existing.mode & 0o777 : 0o644

  try {
    await writeFileAtomically(resolvedPath, contentBuffer, { mode })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AppError('PERMISSION', `Permission denied writing file: ${resolvedPath}`)
    }
    throw err
  }
}

async function readRawSystemFileBuffer(resolvedPath: string): Promise<Buffer> {
  let contentBuffer: Buffer
  try {
    contentBuffer = await readFile(resolvedPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    switch (code) {
      case 'ENOENT': {
        throw new AppError('NOT_FOUND', `File not found: ${resolvedPath}`)
      }
      case 'EACCES': {
        throw new AppError('PERMISSION', `Permission denied reading file: ${resolvedPath}`)
      }
      case 'EISDIR': {
        throw new AppError('VALIDATION', `Path is a directory, not a file: ${resolvedPath}`)
      }
      default: {
        throw err
      }
    }
  }

  return contentBuffer
}

export function decodeSystemTextBuffer(
  buffer: Buffer,
  resolvedPath = '<buffer>'
): { content: string; encoding: SystemTextEncoding } {
  const encoding = detectSystemTextEncoding(buffer)
  if (!encoding) {
    throw new AppError(
      'VALIDATION',
      `File appears to be binary and cannot be read as text: ${resolvedPath}`
    )
  }

  return {
    content: decodeSystemTextContent(buffer, encoding),
    encoding,
  }
}

export function encodeSystemTextContent(
  content: string,
  encoding: SystemTextEncoding
): Buffer {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(content, 'utf-8')])
    case 'utf16le':
      return Buffer.concat([UTF16LE_BOM, Buffer.from(content, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([UTF16BE_BOM, encodeUtf16Be(content)])
    case 'utf16le-nobom':
      return Buffer.from(content, 'utf16le')
    case 'utf16be-nobom':
      return encodeUtf16Be(content)
    case 'utf8':
      return Buffer.from(content, 'utf-8')
  }
}

export function adaptReplacementLineEndings(
  content: string,
  oldText: string,
  newText: string
): { oldText: string; newText: string } {
  if (content.includes(oldText) || !content.includes('\r\n')) return { oldText, newText }

  const oldTextWithCrlf = toCrlf(oldText)
  if (!content.includes(oldTextWithCrlf)) return { oldText, newText }

  return {
    oldText: oldTextWithCrlf,
    newText: toCrlf(newText),
  }
}

export function countOccurrences(value: string, needle: string): number {
  let count = 0
  let index = 0

  while (true) {
    const foundIndex = value.indexOf(needle, index)
    if (foundIndex === -1) return count

    count += 1
    index = foundIndex + needle.length
  }
}

/** 二进制检测：UTF-16 判定后，前 8KB 内仍含 NULL 字节则视为二进制。 */
export function isBinaryBuffer(buf: Buffer): boolean {
  const checkLength = Math.min(buf.length, 8192)
  for (let i = 0; i < checkLength; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

function detectSystemTextEncoding(buffer: Buffer): Nullable<SystemTextEncoding> {
  if (buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) return 'utf8-bom'
  if (buffer.subarray(0, UTF16LE_BOM.length).equals(UTF16LE_BOM)) return 'utf16le'
  if (buffer.subarray(0, UTF16BE_BOM.length).equals(UTF16BE_BOM)) return 'utf16be'

  const utf16NoBom = detectUtf16NoBom(buffer)
  if (utf16NoBom) return utf16NoBom

  if (isBinaryBuffer(buffer)) return null
  return 'utf8'
}

function detectUtf16NoBom(buffer: Buffer): Nullable<SystemTextEncoding> {
  let checkLength = Math.min(buffer.length, 8192)
  checkLength -= checkLength % 2
  if (checkLength < 16) return null

  let evenNul = 0
  let oddNul = 0
  for (let index = 0; index < checkLength; index += 1) {
    if (buffer[index] !== 0) continue
    if (index % 2 === 0) {
      evenNul += 1
    } else {
      oddNul += 1
    }
  }

  const half = checkLength / 2
  if (oddNul * 10 >= half * 3 && evenNul * 20 <= half) return 'utf16le-nobom'
  if (evenNul * 10 >= half * 3 && oddNul * 20 <= half) return 'utf16be-nobom'
  return null
}

function decodeSystemTextContent(buffer: Buffer, encoding: SystemTextEncoding): string {
  switch (encoding) {
    case 'utf8-bom':
      return buffer.subarray(UTF8_BOM.length).toString('utf-8')
    case 'utf16le':
      return buffer.subarray(UTF16LE_BOM.length).toString('utf16le')
    case 'utf16be':
      return decodeUtf16Be(buffer.subarray(UTF16BE_BOM.length))
    case 'utf16le-nobom':
      return buffer.toString('utf16le')
    case 'utf16be-nobom':
      return decodeUtf16Be(buffer)
    case 'utf8':
      return buffer.toString('utf-8')
  }
}

function decodeUtf16Be(buffer: Buffer): string {
  const alignedLength = buffer.length - (buffer.length % 2)
  const swapped = Buffer.from(buffer.subarray(0, alignedLength))
  swapped.swap16()
  return swapped.toString('utf16le')
}

function encodeUtf16Be(content: string): Buffer {
  const swapped = Buffer.from(content, 'utf16le')
  swapped.swap16()
  return swapped
}

function toCrlf(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}

/** 按字符上限裁剪行列表，优先保整行。 */
export function truncateToChars(
  lines: string[],
  maxChars: number
): { content: string; lineCount: number; firstLineTruncated: boolean } {
  const outputLines: string[] = []
  let usedChars = 0

  for (const line of lines) {
    const separatorChars = !isEmpty(outputLines) ? 1 : 0
    const nextChars = usedChars + separatorChars + line.length

    if (nextChars > maxChars) {
      if (isEmpty(outputLines)) return { content: line.slice(0, maxChars), lineCount: 1, firstLineTruncated: true }
      return {
        content: outputLines.join('\n'),
        lineCount: outputLines.length,
        firstLineTruncated: false,
      }
    }

    outputLines.push(line)
    usedChars = nextChars
  }

  return {
    content: outputLines.join('\n'),
    lineCount: outputLines.length,
    firstLineTruncated: false,
  }
}
