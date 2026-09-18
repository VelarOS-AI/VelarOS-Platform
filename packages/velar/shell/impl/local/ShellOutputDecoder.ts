/**
 * 子进程输出的 UTF-8 解码器：`ShellOutputDecoder`。接口 `ShellOutputDecoderApi` 在本文件的类上方。
 * stdout、stderr 各用一个，由命令执行器创建。
 */

import { StringDecoder } from 'node:string_decoder'

/**
 * 子进程输出的 UTF-8 解码器：分块写入也不会把多字节字符切坏，同时统计非法字节序列；输出里本来就有的替换字符 U+FFFD 不算错。
 *
 * 实现是 `ShellOutputDecoder`，stdout 和 stderr 各用一个。
 */
export interface ShellOutputDecoderApi {
  /** 到目前为止遇到的非法 UTF-8 序列个数。 */
  readonly decodeErrors: number
  /** 写入一块原始输出，返回这块里已经能完整解码的文本；被切断的字符留到下一块再吐。 */
  write(chunk: Buffer): string
  /** 输出结束时调用，吐出剩下的文本；末尾残缺的字符计一次错误。重复调用返回空串。 */
  end(): string
}

export class ShellOutputDecoder implements ShellOutputDecoderApi {
  private readonly decoder = new StringDecoder('utf8')
  private remaining = 0
  private minimum = 0x80
  private maximum = 0xbf
  private errors = 0
  private ended = false

  public get decodeErrors(): number {
    return this.errors
  }

  public write(chunk: Buffer): string {
    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index]!
      if (this.remaining > 0) {
        if (byte >= this.minimum && byte <= this.maximum) {
          this.remaining -= 1
          this.minimum = 0x80
          this.maximum = 0xbf
          continue
        }
        this.errors += 1
        this.remaining = 0
      }
      if (byte <= 0x7f) continue
      this.minimum = 0x80
      this.maximum = 0xbf
      if (byte >= 0xc2 && byte <= 0xdf) this.remaining = 1
      else if (byte >= 0xe0 && byte <= 0xef) {
        this.remaining = 2
        if (byte === 0xe0) this.minimum = 0xa0
        if (byte === 0xed) this.maximum = 0x9f
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        this.remaining = 3
        if (byte === 0xf0) this.minimum = 0x90
        if (byte === 0xf4) this.maximum = 0x8f
      } else this.errors += 1
    }
    return this.decoder.write(chunk)
  }

  public end(): string {
    if (this.ended) return ''
    this.ended = true
    if (this.remaining > 0) this.errors += 1
    this.remaining = 0
    return this.decoder.end()
  }
}
