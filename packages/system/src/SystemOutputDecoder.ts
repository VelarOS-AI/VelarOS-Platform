import { StringDecoder } from 'node:string_decoder'

/** 有状态地解码 UTF-8，同时统计非法序列；合法的替换字符不会被误报。 */
export function createSystemOutputDecoder() {
  const decoder = new StringDecoder('utf8')
  let remaining = 0
  let minimum = 0x80
  let maximum = 0xbf
  let errors = 0
  let ended = false

  return {
    get decodeErrors(): number {
      return errors
    },
    write(chunk: Buffer): string {
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index]!
        if (remaining > 0) {
          if (byte >= minimum && byte <= maximum) {
            remaining -= 1
            minimum = 0x80
            maximum = 0xbf
            continue
          }
          errors += 1
          remaining = 0
        }
        if (byte <= 0x7f) continue
        minimum = 0x80
        maximum = 0xbf
        if (byte >= 0xc2 && byte <= 0xdf) remaining = 1
        else if (byte >= 0xe0 && byte <= 0xef) {
          remaining = 2
          if (byte === 0xe0) minimum = 0xa0
          if (byte === 0xed) maximum = 0x9f
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          remaining = 3
          if (byte === 0xf0) minimum = 0x90
          if (byte === 0xf4) maximum = 0x8f
        } else errors += 1
      }
      return decoder.write(chunk)
    },
    end(): string {
      if (ended) return ''
      ended = true
      if (remaining > 0) errors += 1
      remaining = 0
      return decoder.end()
    },
  }
}
