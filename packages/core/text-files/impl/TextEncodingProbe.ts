/**
 * 流式编码识别：`TextEncodingProbe`。接口 `TextEncodingProbeApi` 在本文件的类上方；实例由 `textCodec.createProbe()` 造，一次识别一份，用完即弃。
 */

import type { TextEncoding } from '../types/text-files.js'
import {
  detectUtf16WithoutBom,
  startsWithBytes,
  Utf8Bom,
  Utf16BeBom,
  Utf16LeBom,
} from '../utils/encoding.js'
import { TextFileTuning } from '../utils/tuning.js'

import type { TextStreamDecoderApi } from './TextStreamDecoder.js'
import { TextStreamDecoder } from './TextStreamDecoder.js'

/**
 * 一次流式编码识别：分块喂字节，喂完给结论，内存不随文件增长。四个严格的按块解码器（UTF-8、UTF-16LE、UTF-16BE、GB18030）跟着每一块读，谁遇到非法字节谁出局；
 * 文件头只留开头一段，BOM 与无 BOM 的 UTF-16 只看它。结论的顺序：BOM → 无 BOM 的 UTF-16 → 读到过 NUL 算二进制 → 严格 UTF-8 → GB18030。
 * 由 `textCodec.createProbe()` 造，一次识别一份，不能复用。
 */
export interface TextEncodingProbeApi {
  /** 喂进下一块字节；不留这块字节的引用，调用方之后可以复用这块缓冲。 */
  push(bytes: Uint8Array): void
  /** 字节喂完后给出编码：partial 为真表示只喂了文件开头，末尾被截断的多字节字符不算错；认不出（二进制、非法字节）返回 null。 */
  finish(options?: { partial?: boolean }): Nullable<TextEncoding>
}

export class TextEncodingProbe implements TextEncodingProbeApi {
  /** 跟着读的四个候选：UTF-8（也管带 BOM 的）、两种字节序的 UTF-16（也管不带 BOM 的）、GB18030。 */
  private static readonly Candidates: readonly TextEncoding[] = [
    'utf8',
    'utf16le',
    'utf16be',
    'gb18030',
  ]
  /** 还能无损解码已读字节的候选。 */
  private readonly decoders = new Map<TextEncoding, TextStreamDecoderApi>(
    TextEncodingProbe.Candidates.map((encoding) => [encoding, new TextStreamDecoder(encoding)])
  )
  /** 文件头缓冲，BOM 与无 BOM 的 UTF-16 只看它。 */
  private readonly head = new Uint8Array(TextFileTuning.encoding.headBytes)
  /** 文件头缓冲里已经填了多少字节。 */
  private headLength = 0
  /** 读过的字节里有没有 NUL。 */
  private hasNul = false

  public push(bytes: Uint8Array): void {
    const take = Math.min(bytes.length, this.head.length - this.headLength)
    this.head.set(bytes.subarray(0, take), this.headLength)
    this.headLength += take
    this.hasNul ||= bytes.includes(0)
    for (const [encoding, decoder] of this.decoders) {
      try {
        decoder.push(bytes)
      } catch {
        // arch-guard:silent-catch-ok 解不开正是要的答案：这个候选编码出局。
        this.decoders.delete(encoding)
      }
    }
  }

  public finish(options: { partial?: boolean } = {}): Nullable<TextEncoding> {
    // 读到了文件末尾才核对最后一个字符完不完整；只喂了开头的，末尾截断的字符不算错。
    if (!options.partial) {
      for (const [encoding, decoder] of this.decoders) {
        try {
          decoder.finish()
        } catch {
          // arch-guard:silent-catch-ok 末尾的字符没凑齐：这个候选编码出局。
          this.decoders.delete(encoding)
        }
      }
    }
    const head = this.head.subarray(0, this.headLength)
    if (startsWithBytes(head, Utf8Bom)) return this.decoders.has('utf8') ? 'utf8-bom' : null
    if (startsWithBytes(head, Utf16LeBom)) return this.decoders.has('utf16le') ? 'utf16le' : null
    if (startsWithBytes(head, Utf16BeBom)) return this.decoders.has('utf16be') ? 'utf16be' : null
    const utf16 = detectUtf16WithoutBom(head)
    if (utf16)
      return this.decoders.has(utf16 === 'utf16le-nobom' ? 'utf16le' : 'utf16be') ? utf16 : null
    if (this.hasNul) return null
    if (this.decoders.has('utf8')) return 'utf8'
    if (this.decoders.has('gb18030')) return 'gb18030'
    return null
  }
}
