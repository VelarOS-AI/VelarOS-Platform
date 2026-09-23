/** 图片：认文件头（只读头几个字节，不解码像素）、读宽高、把要看的区域收进图里，以及把图压进上限的策略。都不碰实例状态。 */

import { stat } from 'node:fs/promises'

import { isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { textFileIo } from '@velaros-ai/core/text-files'
import { TextFileErrorCodes } from '@velaros-ai/core/text-files/contracts'

import type { ImageRegion } from '../types/images.js'
import type { ImageMediaType, ImageResizeRequest, ImageResizeResult } from '../types/space.js'

import { ImageTuning } from './tuning.js'

/** 按文件头的魔数认出图片（PNG、JPEG、GIF、WebP）和 PDF；都不是返回 null。 */
export function detectMediaType(buffer: Buffer): Nullable<ImageMediaType> {
  const startsWith = (bytes: number[], at = 0): boolean =>
    buffer.length >= at + bytes.length && bytes.every((byte, index) => buffer[at + index] === byte)
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: 'image', mediaType: 'image/png' }
  if (startsWith([0xff, 0xd8, 0xff])) return { kind: 'image', mediaType: 'image/jpeg' }
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return { kind: 'image', mediaType: 'image/gif' }
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8))
    return { kind: 'image', mediaType: 'image/webp' }
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]))
    return { kind: 'document', mediaType: 'application/pdf' }
  return null
}

/** 读出 Node 文件系统错误的错误码字符串，如 ENOENT；认不出返回 null。 */
function errnoOf(error: unknown): Nullable<string> {
  return isPlainObject(error) && isString(error.code) ? error.code : null
}

/**
 * 把读图时的失败翻成通用码，说明里只用给模型看的写法：路径上某一段不是目录（ENOTDIR）也算找不到，
 * 链接绕圈、名字太长算路径不对；有界读报的文件变大、不是普通文件（读的途中被换掉了）也翻成 VALIDATION。认不出的系统错误按 PLATFORM 说清楚，不把英文原文和绝对路径漏给模型。
 */
function readFailure(error: unknown, shown: string): AppError {
  if (error instanceof AppError) {
    if (error.code === TextFileErrorCodes.tooLarge)
      return new AppError(
        'VALIDATION',
        `图片文件在读的时候变大了，超过上限：${shown}；先用命令缩小再看`
      )
    if (error.code === TextFileErrorCodes.notRegular)
      return new AppError('VALIDATION', `路径不是普通文件：${shown}`)
    return error
  }
  switch (errnoOf(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new AppError('NOT_FOUND', `文件不存在：${shown}`)
    case 'EACCES':
    case 'EPERM':
      return new AppError('PERMISSION', `没有权限读这个文件：${shown}`)
    case 'ELOOP':
    case 'ENAMETOOLONG':
      return new AppError('VALIDATION', `路径不对（符号链接绕成了圈，或者名字太长）：${shown}`)
    default:
      return new AppError('PLATFORM', `读不了这个文件：${shown}（${errnoOf(error) ?? '未知错误'}）`)
  }
}

/** 确认路径是普通文件，再有界地读进来；超过 maxBytes 报错，指向先用命令缩小。 */
export async function readImageFile(
  target: string,
  shown: string,
  maxBytes: number
): Promise<Buffer> {
  const metadata = await stat(target).catch((error: unknown) => {
    throw readFailure(error, shown)
  })
  if (metadata.isDirectory()) throw new AppError('VALIDATION', `路径是目录，不是图片：${shown}`)
  if (!metadata.isFile()) throw new AppError('VALIDATION', `路径不是普通文件：${shown}`)
  if (metadata.size > maxBytes)
    throw new AppError(
      'VALIDATION',
      `图片文件太大：${metadata.size} 字节，上限 ${maxBytes} 字节；先用命令缩小再看`
    )
  const buffer = await textFileIo.readBounded(target, maxBytes).catch((error: unknown) => {
    throw readFailure(error, shown)
  })
  if (!buffer) throw new AppError('NOT_FOUND', `文件不存在：${shown}`)
  return buffer
}

/**
 * 从文件头读出图片的宽高；认不出、或者读出来宽高有一边是 0（这样的图 API 也不收），就返回 null。
 *
 * 只读头：宽高就写在每种格式最前面那几个字节里（PNG 的 IHDR、GIF 的逻辑屏幕、
 * WebP 的 VP8/VP8L/VP8X 头、JPEG 的 SOF 段），用不着把像素解出来。
 */
export function readImageSize(
  buffer: Buffer,
  mediaType: string
): Nullable<{ width: number; height: number }> {
  const size = headerSize(buffer, mediaType)
  return size && size.width > 0 && size.height > 0 ? size : null
}

/** 按格式从文件头里取宽高，不管是不是 0。 */
function headerSize(
  buffer: Buffer,
  mediaType: string
): Nullable<{ width: number; height: number }> {
  if (mediaType === 'image/png' && buffer.length >= 24)
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  if (mediaType === 'image/gif' && buffer.length >= 10)
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  if (mediaType === 'image/webp' && buffer.length >= 30) return readWebpSize(buffer)
  if (mediaType === 'image/jpeg') return readJpegSize(buffer)
  return null
}

/** WebP 三种头：有损 VP8、无损 VP8L、扩展 VP8X，宽高各在不同位置。 */
function readWebpSize(buffer: Buffer): Nullable<{ width: number; height: number }> {
  const chunk = buffer.toString('ascii', 12, 16)
  if (chunk === 'VP8 ')
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X')
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 }
  return null
}

/** JPEG 顺着段往下找第一个 SOF（帧头），宽高在它里面；段长写在每段开头，跳着走不用扫全文件。 */
function readJpegSize(buffer: Buffer): Nullable<{ width: number; height: number }> {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null
    // 标记前允许有任意个 0xFF 填充字节：跳到真正的标记上。
    while (buffer[offset + 1] === 0xff && offset + 9 < buffer.length) offset += 1
    const marker = buffer[offset + 1] ?? 0
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame)
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    offset += 2 + buffer.readUInt16BE(offset + 2)
  }
  return null
}

/** 把要看的那一块收进图里：取它和整张图的交集（四边一样收）；交集是空的就返回 null（整块都在图外）。 */
export function clampImageRegion(
  region: ImageRegion,
  size: { width: number; height: number }
): Nullable<ImageRegion> {
  const left = Math.max(0, Math.floor(region.x))
  const top = Math.max(0, Math.floor(region.y))
  const right = Math.min(size.width, Math.floor(region.x) + Math.floor(region.width))
  const bottom = Math.min(size.height, Math.floor(region.y) + Math.floor(region.height))
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null
}

/** base64 之后有多长：每 3 字节变 4 个字符，不足 3 字节的补齐。API 的图片上限按这个算。 */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * 请宿主把图压进上限：先按长边上限缩一次，base64 之后还超就把长边再收一截，有限次数。
 *
 * 字节数大致跟像素数走，收长边比换格式、调质量可靠——截图里的字换成 JPEG 很容易糊。
 */
export async function shrinkImageToLimits(
  resize: (request: ImageResizeRequest) => Promise<ImageResizeResult>,
  request: Omit<ImageResizeRequest, 'longEdge'>,
  limits: { longEdge: number; base64Bytes: number }
): Promise<ImageResizeResult> {
  let longEdge = limits.longEdge
  let tried = longEdge
  for (let attempt = 0; attempt < ImageTuning.shrinkAttempts; attempt += 1) {
    tried = longEdge
    const resized = await resize({ ...request, longEdge })
    if (base64Length(resized.data.byteLength) <= limits.base64Bytes) return resized
    longEdge = Math.floor(longEdge * ImageTuning.shrinkFactor)
  }
  throw new AppError(
    'VALIDATION',
    `这张图压到长边 ${tried} px 仍超过 ${limits.base64Bytes} 字节；换一块更小的 region 再看`
  )
}
