/**
 * 编解码的纯函数：三种 BOM、TextDecoder 的编码标签、无 BOM 的 UTF-16 识别、孤立代理项、按编码把正文写成字节、严格解码一块字节。
 */

import * as iconv from 'iconv-lite'

import { isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { TextFileErrorCodes } from '../contract/constants.js'
import type { TextEncoding } from '../types/text-files.js'

/** UTF-8 的 BOM。 */
export const Utf8Bom = Uint8Array.of(0xef, 0xbb, 0xbf)

/** 小端 UTF-16 的 BOM。 */
export const Utf16LeBom = Uint8Array.of(0xff, 0xfe)

/** 大端 UTF-16 的 BOM。 */
export const Utf16BeBom = Uint8Array.of(0xfe, 0xff)

/** 一种磁盘编码对应的 TextDecoder 编码标签。 */
export function decoderLabelOf(encoding: TextEncoding): string {
  return encoding.startsWith('utf16le')
    ? 'utf-16le'
    : encoding.startsWith('utf16be')
      ? 'utf-16be'
      : encoding === 'gb18030' ? 'gb18030' : 'utf-8'
}

/** 字节串是不是以给定前缀开头。 */
export function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte)
}

/**
 * 按文件头里 NUL 字节的奇偶分布认无 BOM 的 UTF-16 与它的字节序；认不出返回 null。
 * 不到 16 个字节的只认「ASCII 文本与 NUL 交错」这一种证据，纯非 ASCII 的短文本不凭长度猜字节序。
 */
export function detectUtf16WithoutBom(head: Uint8Array): Nullable<TextEncoding> {
  const length = head.length - (head.length % 2)
  if (length < 2) return null
  if (length < 16) {
    let little = true
    let big = true
    for (let index = 0; index < length; index += 2) {
      little &&= head[index + 1] === 0 && isAsciiTextUnit(head[index]!)
      big &&= head[index] === 0 && isAsciiTextUnit(head[index + 1]!)
    }
    return little ? 'utf16le-nobom' : big ? 'utf16be-nobom' : null
  }
  let evenNul = 0
  let oddNul = 0
  for (let index = 0; index < length; index += 1) {
    if (head[index] !== 0) continue
    if (index % 2 === 0) evenNul += 1
    else oddNul += 1
  }
  // 一种奇偶位上的 NUL 至少占三成、另一种不到二十分之一，才认定是这一字节序的 UTF-16。
  const half = length / 2
  if (oddNul * 10 >= half * 3 && evenNul * 20 <= half) return 'utf16le-nobom'
  if (evenNul * 10 >= half * 3 && oddNul * 20 <= half) return 'utf16be-nobom'
  return null
}

/** 一个字节是不是短 UTF-16 识别认可的 ASCII 文本：制表、换行、回车与可见字符。 */
function isAsciiTextUnit(unit: number): boolean {
  return unit === 0x09 || unit === 0x0a || unit === 0x0d || (unit >= 0x20 && unit <= 0x7e)
}

/** 找正文里第一个孤立代理项（没有配对的 UTF-16 代理码元）：返回它的 UTF-16 下标与码元；没有返回 null。 */
export function findLoneSurrogate(content: string): Nullable<{ offset: number; codeUnit: number }> {
  for (let offset = 0; offset < content.length; offset += 1) {
    const codeUnit = content.charCodeAt(offset)
    if (codeUnit < 0xd800 || codeUnit > 0xdfff) continue
    // 高代理后面紧跟低代理才成对；末尾的高代理后面是 NaN，比较一律为假，同样算孤立。
    const next = content.charCodeAt(offset + 1)
    const paired = codeUnit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    if (!paired) return { offset, codeUnit }
    offset += 1
  }
  return null
}

/** 按编码把正文写成字节，需要 BOM 的带上；正文里有孤立代理项，或 GB18030 写不回原文时抛 lossy。 */
export function encodeText(content: string, encoding: TextEncoding): Buffer {
  const lone = findLoneSurrogate(content)
  if (lone) throw new AppError(TextFileErrorCodes.lossy, `文本在 UTF-16 offset ${lone.offset} 含不完整的 Unicode 字符，拒绝有损写入。`, undefined, lone)
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Utf8Bom, Buffer.from(content, 'utf-8')])
    case 'utf16le':
      return Buffer.concat([Utf16LeBom, Buffer.from(content, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Utf16BeBom, encodeUtf16Be(content)])
    case 'utf16le-nobom':
      return Buffer.from(content, 'utf16le')
    case 'utf16be-nobom':
      return encodeUtf16Be(content)
    case 'gb18030':
      return encodeGb18030(content)
    case 'utf8':
      return Buffer.from(content, 'utf-8')
  }
}

/** 把正文写成大端 UTF-16，不带 BOM。 */
function encodeUtf16Be(content: string): Buffer {
  return Buffer.from(content, 'utf16le').swap16()
}

/** 把正文写成 GB18030：按 GB18030 读回来必须和原文一样，对不上（有 GB18030 表示不了的字符）时抛 lossy，context 带第一处对不上的位置。 */
function encodeGb18030(content: string): Buffer {
  const encoded = iconv.encode(content, 'gb18030')
  const decoded = new TextDecoder('gb18030').decode(encoded)
  if (decoded === content) return encoded
  const offset = firstDifference(content, decoded)
  throw new AppError(
    TextFileErrorCodes.lossy,
    `文本在 UTF-16 offset ${offset} 处有 GB18030 表示不了的字符，无法按 GB18030 无损写回。`,
    undefined,
    { offset, codeUnit: content.charCodeAt(offset) },
  )
}

/** 两段文字第一处不同的 UTF-16 下标；一段是另一段的前缀时是较短那段的长度。 */
function firstDifference(first: string, second: string): number {
  let index = 0
  while (index < first.length && index < second.length && first[index] === second[index]) index += 1
  return index
}

/**
 * GB18030 里从 index 起的这个字符占几个字节，只看首字节和第二个字节：0x80 及以下一个字节，第二个字节是数字（0x30–0x39）的四个字节，其余两个字节。
 * 首字节是最后一个字节、还看不到第二个字节时按两个字节算（反正还没凑齐）。
 */
export function gb18030CharWidth(bytes: Uint8Array, index: number): number {
  if (bytes[index]! <= 0x80) return 1
  const second = bytes[index + 1]
  return isUndefined(second) || second < 0x30 || second > 0x39 ? 2 : 4
}

/** 一段从字符边界开始的 GB18030 字节里，凑齐了的完整字符一共多长；末尾被截断的那个字符不算在内。 */
export function gb18030CompleteLength(bytes: Uint8Array): number {
  let index = 0
  while (index < bytes.length) {
    const width = gb18030CharWidth(bytes, index)
    if (index + width > bytes.length) return index
    index += width
  }
  return index
}

/** 跑一次严格解码，遇到非法字节抛 notText（context 带路径与编码），不静默替换。 */
export function decodeStrictly(decode: () => string, source: { path: string; encoding: TextEncoding }): string {
  try {
    return decode()
  } catch (error) {
    throw new AppError(TextFileErrorCodes.notText, `文件内容不是合法的 ${source.encoding} 文本，无法无损解码。`, error, { ...source })
  }
}
