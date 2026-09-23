/**
 * GB18030 按原字节保留编码：同一个字在 GB18030 里可能有两种写法（别名字节，比如单字节 0x80 与 A2E3 都读成「€」），
 * 改一处就把整个文件重新编码，会连带改掉别处的写法；这里只重新编码改动的片段，没改的片段按原字节拼回。
 */

import { diffChars } from 'diff'

import { AppError } from '@velaros-ai/core/error'

import { TextFileErrorCodes } from '../contract/constants.js'

import { encodeText, gb18030CharWidth } from './encoding.js'
import { TextFileTuning } from './tuning.js'

/**
 * 把改过的正文按 GB18030 写成字节，没改的片段沿用原字节：先把原字节按 GB18030 的字符切开、对上 before 的每个 UTF-16 下标，
 * 再用有界的字符级差异找出没改的片段；差异在上限内算不出来就退回按公共前后缀对齐。original 与 before 对不上时抛 lossy。
 * 只拼字节、不核对结果，调用方要自己确认结果读回来就是 after。
 */
export function spliceGb18030Bytes(original: Uint8Array, before: string, after: string): Buffer {
  const offsets = gb18030CharOffsets(original, before)
  const changes = diffChars(before, after, {
    maxEditLength: TextFileTuning.preserving.maxEditLength,
    timeout: TextFileTuning.preserving.timeoutMs,
  })
  if (changes) {
    const parts: Uint8Array[] = []
    let from = 0
    for (const change of changes) {
      if (change.added) {
        parts.push(encodeText(change.value, 'gb18030'))
        continue
      }
      const end = from + change.value.length
      if (!change.removed) parts.push(original.subarray(offsets[from], offsets[end]))
      from = end
    }
    return Buffer.concat(parts)
  }
  // 差异太大算不出来：只留公共前缀与后缀的原字节，中间整段重新编码；有了时间上限，不会演变成无界的差异搜索。
  // 前后缀的边界落在代理对中间（字节位置记着 0xffffffff）时往里退一个码元。
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix += 1
  if (offsets[prefix] === 0xffffffff) prefix -= 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix += 1
  if (offsets[before.length - suffix] === 0xffffffff) suffix -= 1
  return Buffer.concat([
    original.subarray(0, offsets[prefix]),
    encodeText(after.slice(prefix, after.length - suffix), 'gb18030'),
    original.subarray(offsets[before.length - suffix]),
  ])
}

/**
 * 原字节里 before 每个 UTF-16 下标对应的字节位置，末尾多一项是总长；代理对的后半个不在字符边界上，记 0xffffffff。
 * 字节按 GB18030 的字符宽度一个字一个字往前走；走完了字节与 before 的字符对不上时抛 lossy。
 */
function gb18030CharOffsets(original: Uint8Array, before: string): Uint32Array {
  const offsets = new Uint32Array(before.length + 1).fill(0xffffffff)
  let byte = 0
  let unit = 0
  while (byte < original.length && unit < before.length) {
    offsets[unit] = byte
    byte += gb18030CharWidth(original, byte)
    unit += before.codePointAt(unit)! > 0xffff ? 2 : 1
  }
  offsets[unit] = byte
  if (byte !== original.length || unit !== before.length)
    throw new AppError(TextFileErrorCodes.lossy, '原始字节与文本坐标不一致。', undefined, {
      bytes: original.length,
      chars: before.length,
    })
  return offsets
}
