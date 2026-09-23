/**
 * 按块严格解码：`TextStreamDecoder`。接口 `TextStreamDecoderApi` 在本文件的类上方；实例由 `textCodec.createDecoder(encoding)` 造，一段字节流一份。
 */

import type { TextEncoding } from '../types/text-files.js'
import { decoderLabelOf, gb18030CompleteLength } from '../utils/encoding.js'

/**
 * 按块严格解码一段字节流：遇到非法字节抛错，不静默替换；被块边界切开的多字节字符留到下一块，不会丢，也不会被当成错。
 * UTF-8 与 UTF-16 交给 TextDecoder 的流式模式；GB18030 不用 TextDecoder 的流式状态（Bun 的实现会把跨块的字丢掉），
 * 自己把末尾没凑齐的字符留下、接到下一块前面，凑齐的整段一次解完。由 `textCodec.createDecoder(encoding)` 造，一段字节流一份。
 */
export interface TextStreamDecoderApi {
  /** 解下一块字节，返回这块里凑齐的正文；不留这块字节的引用，调用方之后可以复用这块缓冲。遇到非法字节抛错。 */
  push(bytes: Uint8Array): string
  /** 字节流结束：返回最后凑齐的正文；还留着没凑齐的字节（字符被截断）时抛错。 */
  finish(): string
}

export class TextStreamDecoder implements TextStreamDecoderApi {
  private readonly decoder: TextDecoder
  /** GB18030 自己接块，其余编码用 TextDecoder 的流式模式。 */
  private readonly joinsChunks: boolean
  /** GB18030 上一块末尾没凑齐的字节（最多三个）；没有为 null。 */
  private pending: Nullable<Uint8Array> = null

  constructor(encoding: TextEncoding) {
    this.decoder = new TextDecoder(decoderLabelOf(encoding), { fatal: true })
    this.joinsChunks = encoding === 'gb18030'
  }

  public push(bytes: Uint8Array): string {
    if (!this.joinsChunks) return this.decoder.decode(bytes, { stream: true })
    const joined = this.pending ? Buffer.concat([this.pending, bytes]) : bytes
    const complete = gb18030CompleteLength(joined)
    // 留下的那几个字节要拷一份：joined 可能就是调用方之后会复用的缓冲。
    this.pending = complete < joined.length ? Uint8Array.from(joined.subarray(complete)) : null
    return this.decoder.decode(joined.subarray(0, complete))
  }

  public finish(): string {
    if (!this.joinsChunks) return this.decoder.decode()
    const rest = this.pending
    this.pending = null
    return rest ? this.decoder.decode(rest) : ''
  }
}
