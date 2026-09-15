/**
 * 文本与媒体文件：读文本文件、认出图片（和 PDF，只为把错误说清楚）、按字符取段、版本号与印记。
 * 编码的识别、严格解码与按原编码写回在公共件 `@velaros-ai/text-files`；这里只把它的结论翻成本包的报错。
 */

import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

import { AppError } from '@velaros-ai/core/error'
import { textCodec, textFileIo } from '@velaros-ai/text-files'
import type { DecodedText, TextEncoding } from '@velaros-ai/text-files/contracts'
import { TextFileErrorCodes } from '@velaros-ai/text-files/contracts'

import type { SystemFileStamp, SystemMediaType, SystemReadFileResult, SystemTextFileContent, SystemTextRange, SystemTextSlice } from '../types/files.js'

import { readErrnoCode } from './fs.js'
import { SystemTuning } from './tuning.js'

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
        throw new AppError('NOT_FOUND', `文件不存在：${resolvedPath}`)
      }
      case 'EACCES': {
        throw new AppError('PERMISSION', `没有权限读这个文件：${resolvedPath}`)
      }
      case 'EISDIR': {
        throw new AppError('VALIDATION', `路径是目录，不是文件：${resolvedPath}`)
      }
      default: {
        throw err
      }
    }
  }

  return contentBuffer
}

/** 识别字节的文本编码并严格解码；认不出（二进制、非法字节、认不出的编码）时报错，报错里提示图片用 system:view 看。 */
export function decodeSystemTextBuffer(buffer: Buffer, resolvedPath = '<buffer>'): DecodedText {
  const decoded = textCodec.decode(buffer)
  if (!decoded) throw binaryTextError(resolvedPath)
  return decoded
}

/** 大文件整个覆盖前只读开头一段认编码（按「只看了开头」认，末尾被截断的字符不算错）；认不出按二进制报错。 */
export async function readSystemTextEncodingFromHead(resolvedPath: string): Promise<TextEncoding> {
  const encoding = textCodec.detect(await textFileIo.readHead(resolvedPath, SystemTuning.files.textSniffBytes), { partial: true })
  if (!encoding) throw binaryTextError(resolvedPath)
  return encoding
}

/** 解码再按原编码编回去，是不是正好得到原来的字节；编不回去（GB18030 表示不了的字符）也算不是。 */
export function reencodesExactly(textFile: SystemTextFileContent): boolean {
  try {
    return textCodec.encode(textFile.content, textFile.encoding).equals(textFile.buffer)
  } catch {
    // arch-guard:silent-catch-ok 编不回去就是答案：这个文件改写会丢数据。
    return false
  }
}

/** 认不出是文本时的报错：二进制文件读不了，图片用 system:view 看。 */
function binaryTextError(resolvedPath: string): AppError {
  return new AppError('VALIDATION', `文件是二进制的，不能当文本读：${resolvedPath}（图片用 system:view 看，其他二进制文件读不了）`)
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
      throw new AppError('VALIDATION', `路径是目录，不是文件：${resolvedPath}`)
    }
    throw new AppError('VALIDATION', `路径不是普通文件：${resolvedPath}`)
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

/** 确认路径是普通文件，再在同一个句柄上有界读进来（读的途中变长了报外部修改）；超过 maxBytes 报错，让调用方用系统命令截取。 */
export async function readBoundedFile(resolvedPath: string, maxBytes: number): Promise<Buffer> {
  await assertRegularFile(resolvedPath)
  const buffer = await textFileIo.readBounded(resolvedPath, maxBytes).catch((err: unknown) => {
    if (err instanceof AppError && err.code === TextFileErrorCodes.tooLarge) {
      throw new AppError('VALIDATION', `文件太大，不能一次读进来：${String(err.context.size)} 字节，上限 ${maxBytes} 字节；用 system:run 截取其中一段`)
    }
    throw normalizeReadError(err, resolvedPath)
  })
  if (!buffer) throw new AppError('NOT_FOUND', `文件不存在：${resolvedPath}`)
  return buffer
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
      return new AppError('NOT_FOUND', `文件不存在：${resolvedPath}`)
    case 'EACCES':
    case 'EPERM':
      return new AppError('PERMISSION', `没有权限读这个文件：${resolvedPath}`)
    case 'EISDIR':
      return new AppError('VALIDATION', `路径是目录，不是文件：${resolvedPath}`)
    default:
      return err instanceof Error ? err : new AppError('UNKNOWN', String(err))
  }
}
