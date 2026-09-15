/**
 * 文本与媒体文件：识别编码、读文本文件、认出图片（和 PDF，只为把错误说清楚）、按字符取段。
 */

import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'

import { AppError } from '@velaros-ai/core/error'

import type { SystemFileStamp, SystemMediaType, SystemReadFileResult, SystemTextEncoding, SystemTextFileContent, SystemTextRange,SystemTextSlice } from '../types/files.js'

import { readErrnoCode } from './fs.js'
import { SystemTuning } from './tuning.js'

const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF])

const UTF16LE_BOM = Buffer.from([0xFF, 0xFE])

const UTF16BE_BOM = Buffer.from([0xFE, 0xFF])

/** 从 stat 结果取文件印记（修改时间与大小）；不存在或不是普通文件时为 null。 */
export function stampOf(stats: Nullable<Stats>): Nullable<SystemFileStamp> {
  if (!stats?.isFile()) return null
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}

/** 写之前能不能只凭印记断定文件没变：两边印记相同，且文件大到重读不划算；小文件和不存在的文件都回答不能，让调用方重读核版本。 */
export function stampProvesUnchanged(before: Nullable<SystemFileStamp>, now: Nullable<SystemFileStamp>): boolean {
  if (!before || !now) return false
  return before.mtimeMs === now.mtimeMs && before.size === now.size && before.size > SystemTuning.files.alwaysRehashBytes
}

/** 只读文件开头的一段字节（认编码、判二进制用），不把整个文件读进来。 */
export async function readFileHead(resolvedPath: string, bytes: number): Promise<Buffer> {
  const handle = await open(resolvedPath, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** 文件现在的版本号：不存在或不是普通文件就是 null。 */
export async function currentFileVersion(resolvedPath: string): Promise<Nullable<string>> {
  const existing = await stat(resolvedPath).catch(() => null)
  if (!existing?.isFile()) return null
  return fileVersionOf(await readRawSystemFileBuffer(resolvedPath))
}

/** 读取一个文本文件，识别编码后返回原始字节、文本内容与编码；二进制文件报错。 */
export async function readSystemTextFile(resolvedPath: string): Promise<SystemTextFileContent> {
  const buffer = await readRawSystemFileBuffer(resolvedPath)
  const decoded = decodeSystemTextBuffer(buffer, resolvedPath)
  return {
    buffer,
    ...decoded,
  }
}

/** 读取文件的原始字节，把找不到、无权限、是目录这几类错误翻成对应的错误码。 */
export async function readRawSystemFileBuffer(resolvedPath: string): Promise<Buffer> {
  let contentBuffer: Buffer
  try {
    contentBuffer = await readFile(resolvedPath)
  } catch (err) {
    switch (readErrnoCode(err)) {
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

/** 识别字节的文本编码并解码；识别为二进制时报错，报错里提示图片和 PDF 走 read 也能看。 */
export function decodeSystemTextBuffer(
  buffer: Buffer,
  resolvedPath = '<buffer>'
): { content: string; encoding: SystemTextEncoding } {
  const encoding = detectSystemTextEncoding(buffer)
  if (!encoding) {
    throw new AppError(
      'VALIDATION',
      `File is binary and cannot be read as text: ${resolvedPath} (images and PDFs are readable; other binaries are not)`
    )
  }

  return {
    content: decodeSystemTextContent(buffer, encoding),
    encoding,
  }
}

/** 按指定编码把文本编码成字节，需要时带上 BOM。 */
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

/** 判断字节像不像二进制：开头 SystemTuning.files.textSniffBytes 字节内出现 NUL 字节即视为二进制。 */
export function isBinaryBuffer(buf: Buffer): boolean {
  const checkLength = Math.min(buf.length, SystemTuning.files.textSniffBytes)
  for (let i = 0; i < checkLength; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** 识别字节的文本编码（UTF-8、带 BOM 的 UTF-8、UTF-16 各种变体）；像二进制时返回 null。 */
function detectSystemTextEncoding(buffer: Buffer): Nullable<SystemTextEncoding> {
  if (buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) return 'utf8-bom'
  if (buffer.subarray(0, UTF16LE_BOM.length).equals(UTF16LE_BOM)) return 'utf16le'
  if (buffer.subarray(0, UTF16BE_BOM.length).equals(UTF16BE_BOM)) return 'utf16be'

  const utf16NoBom = detectUtf16NoBom(buffer)
  if (utf16NoBom) return utf16NoBom

  if (isBinaryBuffer(buffer)) return null
  return 'utf8'
}

/** 按 NUL 字节的分布猜测无 BOM 的 UTF-16 字节序；猜不出返回 null。 */
function detectUtf16NoBom(buffer: Buffer): Nullable<SystemTextEncoding> {
  let checkLength = Math.min(buffer.length, SystemTuning.files.textSniffBytes)
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

/** 按已识别的编码把字节解码成文本。 */
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

/** 把 UTF-16 大端字节解码成文本。 */
function decodeUtf16Be(buffer: Buffer): string {
  const alignedLength = buffer.length - (buffer.length % 2)
  const swapped = Buffer.from(buffer.subarray(0, alignedLength))
  swapped.swap16()
  return swapped.toString('utf16le')
}

/** 把文本编码成 UTF-16 大端字节。 */
function encodeUtf16Be(content: string): Buffer {
  const swapped = Buffer.from(content, 'utf16le')
  swapped.swap16()
  return swapped
}

/** 算出一份文件内容的版本号：字节的 SHA-1 前 12 位，内容一样版本号就一样。 */
export function fileVersionOf(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex').slice(0, 12)
}

/** 确认路径是一个普通文件，返回它的字节数；目录、设备文件、不存在、无权限各报对应的错误。 */
export async function assertRegularFile(resolvedPath: string): Promise<number> {
  try {
    const metadata = await stat(resolvedPath)
    if (metadata.isFile()) return metadata.size
    if (metadata.isDirectory()) {
      throw new AppError('VALIDATION', `Path is a directory, not a file: ${resolvedPath}`)
    }
    throw new AppError('VALIDATION', `Path is not a regular file: ${resolvedPath}`)
  } catch (err) {
    throw normalizeReadError(err, resolvedPath)
  }
}

/** 按文件头的魔数认出图片（PNG、JPEG、GIF、WebP）和 PDF；都不是返回 null。 */
export function detectMediaType(buffer: Buffer): Nullable<SystemMediaType> {
  const startsWith = (bytes: number[], at = 0): boolean =>
    buffer.length >= at + bytes.length && bytes.every((byte, index) => buffer[at + index] === byte)
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mediaType: 'image/png' }
  if (startsWith([0xff, 0xd8, 0xff])) return { kind: 'image', mediaType: 'image/jpeg' }
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return { kind: 'image', mediaType: 'image/gif' }
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return { kind: 'image', mediaType: 'image/webp' }
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'document', mediaType: 'application/pdf' }
  return null
}

/** 把一个字符范围收进文本长度以内，起止都不切开代理对；end 小于 offset 时按空范围处理。 */
export function clampTextRange(content: string, range: SystemTextRange): SystemTextRange {
  const isHigh = (index: number): boolean => content.charCodeAt(index) >= 0xd800 && content.charCodeAt(index) <= 0xdbff
  const isLow = (index: number): boolean => content.charCodeAt(index) >= 0xdc00 && content.charCodeAt(index) <= 0xdfff
  let offset = Math.min(Math.max(0, Math.floor(range.offset)), content.length)
  if (offset > 0 && offset < content.length && isLow(offset) && isHigh(offset - 1)) offset += 1
  let end = Math.min(Math.max(offset, Math.floor(range.end)), content.length)
  if (end < content.length && end > offset && isHigh(end - 1) && isLow(end)) end += 1
  return { offset, end }
}

/** 按字符取一段：从 offset 起最多 maxChars 个，不切开代理对，返回内容和它实际落在的范围；maxChars 为 0 时返回空段。 */
export function sliceTextChars(content: string, offset: number, maxChars: number): SystemTextSlice {
  const range = clampTextRange(content, { offset, end: offset + Math.max(0, maxChars) })
  return { content: content.slice(range.offset, range.end), range }
}

/** 确认路径是普通文件且不超过 maxBytes，然后整个读进来；太大报错，让调用方用系统命令截取。 */
export async function readBoundedFile(resolvedPath: string, maxBytes: number): Promise<Buffer> {
  const size = await assertRegularFile(resolvedPath)
  if (size > maxBytes) {
    throw new AppError('VALIDATION', `File is too large to read at once: ${size} bytes > ${maxBytes} bytes; take a part of it with system:run`)
  }
  return readRawSystemFileBuffer(resolvedPath)
}

/** 把一份字节按文本解码后从 offset 起取最多 maxChars 个字符，连同范围与版本号一起组成读取结果。 */
export function readTextWindow(resolvedPath: string, buffer: Buffer, offset: number, maxChars: number): SystemReadFileResult {
  const { content, encoding } = decodeSystemTextBuffer(buffer, resolvedPath)
  const slice = sliceTextChars(content, offset, maxChars)
  return {
    path: resolvedPath,
    version: fileVersionOf(buffer),
    content: slice.content,
    range: slice.range,
    totalChars: content.length,
    hasMore: slice.range.end < content.length,
    encoding,
  }
}

/** 把读文件时的系统错误翻成对应的错误码。 */
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
