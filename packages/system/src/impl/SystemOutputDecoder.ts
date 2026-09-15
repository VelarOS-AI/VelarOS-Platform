/**
 * 子进程输出的 UTF-8 解码器：`SystemOutputDecoder`。接口见 `contract/commands.ts` 的 `SystemOutputDecoderApi`。
 * stdout、stderr 各用一个，由命令执行器创建。
 */

import { StringDecoder } from 'node:string_decoder'

import type { SystemOutputDecoderApi } from '../interface/internal.js'

export class SystemOutputDecoder implements SystemOutputDecoderApi {
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
