/**
 * 编解码：`TextCodec` 与整个进程唯一的 `textCodec`。接口 `TextCodecApi` 在本文件的类上方。
 * 编码与字节拼接本身是纯函数，在 `utils/encoding.ts`、`utils/preserving.ts`；这个类是它们对外的唯一出口。
 */

import { isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { TextEncodings, TextFileErrorCodes } from '../contract/constants.js'
import type { DecodedText, TextEncoding } from '../types/text-files.js'
import { encodeText, findLoneSurrogate } from '../utils/encoding.js'
import { spliceGb18030Bytes } from '../utils/preserving.js'

import type { TextEncodingProbeApi } from './TextEncodingProbe.js'
import { TextEncodingProbe } from './TextEncodingProbe.js'
import type { TextStreamDecoderApi } from './TextStreamDecoder.js'
import { TextStreamDecoder } from './TextStreamDecoder.js'

/**
 * 磁盘文本的编解码，实例是 `textCodec`：认编码、严格解码、按原编码无损写回。读写磁盘文本的地方都走它，对同一份字节的判定处处一致。
 *
 * 认编码的顺序：BOM → 无 BOM 的 UTF-16（按 NUL 字节的奇偶分布；不到 16 字节的只认 ASCII 与 NUL 交错）→ 读到过 NUL 算二进制 → 严格 UTF-8 → GB18030。
 * 解码一律严格：认不出或有非法字节的不当文本，不会用替换字符凑出一段文字。编码一律无损：孤立代理项、GB18030 表示不了的字符都拒绝，不静默替换。
 */
export interface TextCodecApi {
  /** 认一段字节的磁盘编码；partial 为真表示这只是文件开头，末尾被截断的多字节字符不算错。认不出（二进制、非法字节）返回 null。 */
  detect(bytes: Uint8Array, options?: { partial?: boolean }): Nullable<TextEncoding>
  /** 认出编码后严格解码，BOM 不进正文；认不出返回 null。 */
  decode(bytes: Uint8Array): Nullable<DecodedText>
  /** 按编码建一个严格的按块解码器：一块一块 push，最后 finish 收尾；遇到非法字节抛错，被块边界切开的字符不会丢（不依赖运行时 TextDecoder 的流式实现）。 */
  createDecoder(encoding: TextEncoding): TextStreamDecoderApi
  /** 开始一次流式编码识别：分块 push 字节，最后 finish 给结论。 */
  createProbe(): TextEncodingProbeApi
  /** 按编码把正文写成字节，需要 BOM 的带上；正文里有孤立代理项，或 GB18030 写不回原文时抛 lossy，context 带 offset 与 codeUnit。 */
  encode(content: string, encoding: TextEncoding): Buffer
  /**
   * 改过的正文按原文件的编码写成字节，尽量沿用没改的片段的原字节：GB18030 里同一个字可能有两种写法（别名字节），没改的片段按原字节拼回；
   * 其余编码等同 encode。before 与 after 一样时原样返回 original；GB18030 下 original 与 before 对不上、或拼出的字节读回来不是 after 时抛 lossy。
   */
  encodePreserving(original: Uint8Array, before: string, after: string, encoding: TextEncoding): Buffer
  /** 找正文里第一个孤立代理项（没有配对的 UTF-16 代理码元）：返回它的 UTF-16 下标与码元；没有返回 null。 */
  findLoneSurrogate(content: string): Nullable<{ offset: number; codeUnit: number }>
  /** 一个值是不是本包认识的编码名；持久化或补丁 metadata 里读回的编码名用它核对。 */
  isEncoding(value: unknown): value is TextEncoding
}

export class TextCodec implements TextCodecApi {
  public detect(bytes: Uint8Array, options: { partial?: boolean } = {}): Nullable<TextEncoding> {
    const probe = this.createProbe()
    probe.push(bytes)
    return probe.finish(options)
  }

  public decode(bytes: Uint8Array): Nullable<DecodedText> {
    const encoding = this.detect(bytes)
    if (!encoding) return null
    const decoder = this.createDecoder(encoding)
    return { content: decoder.push(bytes) + decoder.finish(), encoding }
  }

  public createDecoder(encoding: TextEncoding): TextStreamDecoderApi {
    return new TextStreamDecoder(encoding)
  }

  public createProbe(): TextEncodingProbeApi {
    return new TextEncodingProbe()
  }

  public encode(content: string, encoding: TextEncoding): Buffer {
    return encodeText(content, encoding)
  }

  public encodePreserving(original: Uint8Array, before: string, after: string, encoding: TextEncoding): Buffer {
    if (before === after) return Buffer.from(original)
    if (encoding !== 'gb18030') return this.encode(after, encoding)
    const result = spliceGb18030Bytes(original, before, after)
    if (this.decode(result)?.content !== after) throw new AppError(TextFileErrorCodes.lossy, '字节编辑无法无损表示目标文本。', undefined, { encoding })
    return result
  }

  public findLoneSurrogate(content: string): Nullable<{ offset: number; codeUnit: number }> {
    return findLoneSurrogate(content)
  }

  public isEncoding(value: unknown): value is TextEncoding {
    return isString(value) && (TextEncodings as readonly string[]).includes(value)
  }
}

/** 整个进程只有一份的编解码。 */
export const textCodec: TextCodecApi = new TextCodec()
