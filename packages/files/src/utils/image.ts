/** 图片：头的解析与区域换算（只读头几个字节，不解码像素），以及把图压进上限的策略。都不碰实例状态。 */

import { AppError } from '@velaros-ai/core/error'

import type { FileImageRegion } from '../types/files.js'
import type { FileImageResizeRequest, FileImageResizeResult } from '../types/space.js'

import { FileTuning } from './tuning.js'

/**
 * 从文件头读出图片的宽高；认不出就返回 null。
 *
 * 只读头：宽高就写在每种格式最前面那几个字节里（PNG 的 IHDR、GIF 的逻辑屏幕、
 * WebP 的 VP8/VP8L/VP8X 头、JPEG 的 SOF 段），用不着把像素解出来。
 */
export function readImageSize(buffer: Buffer, mediaType: string): Nullable<{ width: number; height: number }> {
  if (mediaType === 'image/png' && buffer.length >= 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  if (mediaType === 'image/gif' && buffer.length >= 10) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  if (mediaType === 'image/webp' && buffer.length >= 30) return readWebpSize(buffer)
  if (mediaType === 'image/jpeg') return readJpegSize(buffer)
  return null
}

/** WebP 三种头：有损 VP8、无损 VP8L、扩展 VP8X，宽高各在不同位置。 */
function readWebpSize(buffer: Buffer): Nullable<{ width: number; height: number }> {
  const chunk = buffer.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 }
  return null
}

/** JPEG 顺着段往下找第一个 SOF（帧头），宽高在它里面；段长写在每段开头，跳着走不用扫全文件。 */
function readJpegSize(buffer: Buffer): Nullable<{ width: number; height: number }> {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null
    const marker = buffer[offset + 1] ?? 0
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    offset += 2 + buffer.readUInt16BE(offset + 2)
  }
  return null
}

/** 把要看的那一块收进图里；收完是空的就返回 null（整块都在图外）。 */
export function clampImageRegion(region: FileImageRegion, size: { width: number; height: number }): Nullable<FileImageRegion> {
  const x = Math.max(0, Math.floor(region.x))
  const y = Math.max(0, Math.floor(region.y))
  const width = Math.min(Math.floor(region.width), size.width - x)
  const height = Math.min(Math.floor(region.height), size.height - y)
  return width > 0 && height > 0 ? { x, y, width, height } : null
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
  resize: (request: FileImageResizeRequest) => Promise<FileImageResizeResult>,
  request: Omit<FileImageResizeRequest, 'longEdge'>,
  limits: { longEdge: number; base64Bytes: number }
): Promise<FileImageResizeResult> {
  let longEdge = limits.longEdge
  for (let attempt = 0; attempt < FileTuning.image.shrinkAttempts; attempt += 1) {
    const resized = await resize({ ...request, longEdge })
    if (base64Length(resized.data.byteLength) <= limits.base64Bytes) return resized
    longEdge = Math.floor(longEdge * FileTuning.image.shrinkFactor)
  }
  throw new AppError('VALIDATION', `这张图压到长边 ${longEdge} px 仍超过 ${limits.base64Bytes} 字节；换一块更小的 region 再看`)
}
