/**
 * 文本文件：有界地读进来、认出图片与 PDF（只为把错误说清楚）、整份解码、版本号与印记。
 * 编码的识别、严格解码与按原编码写回在公共件 `@velaros-ai/core/text-files`；这里只把它的结论翻成本包的报错。
 * 每个函数都拿两个路径：`target` 是真正读的文件，`shown` 是报错里给模型看的写法。
 */

import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

import { AppError } from '@velaros-ai/core/error'
import { textCodec, textFileIo } from '@velaros-ai/core/text-files'
import type { DecodedText } from '@velaros-ai/core/text-files/contracts'
import { TextFileErrorCodes } from '@velaros-ai/core/text-files/contracts'

import type { FileStamp } from '../types/edit.js'
import type { FileMediaType, FileTextContent } from '../types/text.js'

import { normalizeReadError } from './fs.js'
import { FileTuning } from './tuning.js'

/** 从 stat 结果取文件印记（修改时间与大小）；不存在或不是普通文件时为 null。 */
export function stampOf(stats: Nullable<Stats>): Nullable<FileStamp> {
  if (!stats?.isFile()) return null
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}

/** 写之前能不能只凭印记断定文件没变：两边印记相同，且文件大到重读不划算；小文件和不存在的文件都回答不能，让调用方重读核版本。 */
export function stampProvesUnchanged(before: Nullable<FileStamp>, now: Nullable<FileStamp>): boolean {
  if (!before || !now) return false
  return before.mtimeMs === now.mtimeMs && before.size === now.size && before.size > FileTuning.io.alwaysRehashBytes
}

/** 算出一份文件内容的版本号：字节的 SHA-1 前 12 位，内容一样版本号就一样。 */
export function fileVersionOf(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex').slice(0, 12)
}

/** 文件现在的版本号：不存在或不是普通文件就是 null。 */
export async function currentFileVersion(target: string): Promise<Nullable<string>> {
  const existing = await stat(target).catch(() => null)
  if (!existing?.isFile()) return null
  return fileVersionOf(await readRawFile(target, target))
}

/** 读取文件的原始字节，把找不到、无权限、是目录这几类错误翻成对应的错误码。 */
export async function readRawFile(target: string, shown: string): Promise<Buffer> {
  try {
    return await readFile(target)
  } catch (err) {
    throw normalizeReadError(err, shown)
  }
}

/** 读取一个文本文件，识别编码后返回原始字节、文本内容与编码；二进制文件报错。 */
export async function readTextFile(target: string, shown: string): Promise<FileTextContent> {
  const buffer = await readRawFile(target, shown)
  return { buffer, ...decodeText(buffer, shown) }
}

/** 识别字节的文本编码并严格解码；认不出（二进制、非法字节、认不出的编码）时报错，报错里提示图片怎么看。 */
export function decodeText(buffer: Buffer, shown: string): DecodedText {
  const decoded = textCodec.decode(buffer)
  if (!decoded) throw binaryTextError(shown)
  return decoded
}

/** 认不出是文本时的报错：二进制文件读不了，图片用 `velar:images` 看。 */
function binaryTextError(shown: string): AppError {
  return new AppError('VALIDATION', `文件是二进制的，不能当文本读：${shown}（图片用 velar:images 的 view 看，其他二进制文件用命令处理）`)
}

/** 按文件头的魔数认出图片（PNG、JPEG、GIF、WebP）和 PDF；都不是返回 null。 */
export function detectMediaType(buffer: Buffer): Nullable<FileMediaType> {
  const startsWith = (bytes: number[], at = 0): boolean =>
    buffer.length >= at + bytes.length && bytes.every((byte, index) => buffer[at + index] === byte)
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mediaType: 'image/png' }
  if (startsWith([0xff, 0xd8, 0xff])) return { kind: 'image', mediaType: 'image/jpeg' }
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return { kind: 'image', mediaType: 'image/gif' }
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return { kind: 'image', mediaType: 'image/webp' }
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'document', mediaType: 'application/pdf' }
  return null
}

/** 确认路径是普通文件，再在同一个句柄上有界读进来（读的途中变长了报外部修改）；超过 maxBytes 报错，指向用命令取片段。 */
export async function readBoundedFile(target: string, shown: string, maxBytes: number): Promise<Buffer> {
  const metadata = await stat(target).catch((err: unknown) => {
    throw normalizeReadError(err, shown)
  })
  if (metadata.isDirectory()) throw new AppError('VALIDATION', `路径是目录，不是文件：${shown}`)
  if (!metadata.isFile()) throw new AppError('VALIDATION', `路径不是普通文件：${shown}`)
  const buffer = await textFileIo.readBounded(target, maxBytes).catch((err: unknown) => {
    if (err instanceof AppError && err.code === TextFileErrorCodes.tooLarge) {
      throw new AppError('VALIDATION', `文件太大，不能读进来：${String(err.context.size)} 字节，上限 ${maxBytes} 字节；用 run 取片段（tail -n、grep、sed -n 'a,bp'）`)
    }
    throw normalizeReadError(err, shown)
  })
  if (!buffer) throw new AppError('NOT_FOUND', `文件不存在：${shown}`)
  return buffer
}
