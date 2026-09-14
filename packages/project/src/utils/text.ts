import * as iconv from 'iconv-lite'

import { isEmpty, isPresent, isString } from '@velaros-ai/core'

import { ProjectError } from '../errors.js'
import type { Range } from '../types/common.js'
import type { ProjectTextEncoding } from '../types/text.js'

export type { ProjectTextEncoding } from '../types/text.js'

/** 拒绝会被 Buffer/TextEncoder 静默替换的孤立 surrogate；不解释字面反斜杠转义。 */
export function assertWellFormedProjectText(content: string): void {
  for (let offset = 0; offset < content.length; offset += 1) {
    const unit = content.charCodeAt(offset)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = content.charCodeAt(offset + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        offset += 1
        continue
      }
    } else if (unit < 0xdc00 || unit > 0xdfff) continue
    throw new ProjectError(
      'INVALID_INPUT',
      `文本在 UTF-16 offset ${offset} 含不完整的 Unicode 字符，拒绝有损写入。`,
      { offset, codeUnit: unit },
      '请重新构造该字符的完整内容；不要把截断的 surrogate 当作字符提交。',
    )
  }
}

const ProjectTextEncodings: ReadonlySet<string> = new Set<ProjectTextEncoding>([
  'utf8',
  'utf8-bom',
  'utf16le',
  'utf16be',
  'utf16le-nobom',
  'utf16be-nobom',
  'gb18030',
])

/** 持久化或补丁 metadata 里读回的编码名是否是本包认识的文本编码。 */
export function isProjectTextEncoding(value: unknown): value is ProjectTextEncoding {
  return isString(value) && ProjectTextEncodings.has(value)
}

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = new Uint8Array([0xff, 0xfe])
const UTF16BE_BOM = new Uint8Array([0xfe, 0xff])

export function isProbablyBinary(data: Buffer | Uint8Array): boolean {
  return !detectProjectTextEncoding(data)
}

/** 一次确定物理编码后解码；不会把半个 UTF-8 字符重新解释成另一种编码。 */
export function decodeProjectTextBuffer(data: Buffer | Uint8Array): Nullable<string> {
  const encoding = detectProjectTextEncoding(data)
  return encoding ? createProjectTextDecoder(encoding).decode(data) : null
}

export function createProjectTextDecoder(encoding: ProjectTextEncoding): TextDecoder {
  const label = encoding.startsWith('utf16le')
    ? 'utf-16le'
    : encoding.startsWith('utf16be')
      ? 'utf-16be'
      : encoding === 'gb18030' ? 'gb18030' : 'utf-8'
  return new TextDecoder(label, { fatal: true })
}

/** 模型提供的正文使用统一逻辑换行；字面转义、孤立 CR 和正文中的 BOM 字符保持原样。 */
export function normalizeProjectInputText(content: string): string {
  assertWellFormedProjectText(content)
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

export function encodeProjectTextBuffer(
  content: string,
  encoding: ProjectTextEncoding = 'utf8',
): Buffer {
  assertWellFormedProjectText(content)
  switch (encoding) {
    case 'utf8-bom':
      return prefixBytes(UTF8_BOM, Buffer.from(content, 'utf-8'))
    case 'utf16le':
      return prefixBytes(UTF16LE_BOM, Buffer.from(content, 'utf16le'))
    case 'utf16be':
      return prefixBytes(UTF16BE_BOM, encodeUtf16Be(content))
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

/** 探测失败是候选结果，错误显式返回给调用方淘汰该编码。 */
function validateTextChunk(
  decoder: TextDecoder,
  bytes: Uint8Array,
  stream: boolean,
): Nullable<{ error: unknown }> {
  try {
    decoder.decode(bytes, { stream })
    return null
  } catch (error) {
    return { error }
  }
}

/** 流式候选验证只保存有限文件头；到 EOF 才提交编码判定。 */
export class ProjectTextEncodingProbe {
  private readonly decoders = new Map<string, TextDecoder>(
    ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].map((label) =>
      [label, new TextDecoder(label, { fatal: true })]),
  )
  private readonly head = new Uint8Array(8192)
  private headLength = 0
  private hasNul = false

  public push(bytes: Uint8Array): void {
    const take = Math.min(bytes.length, this.head.length - this.headLength)
    this.head.set(bytes.subarray(0, take), this.headLength)
    this.headLength += take
    this.hasNul ||= bytes.includes(0)
    for (const [label, decoder] of this.decoders) {
      if (validateTextChunk(decoder, bytes, true)) this.decoders.delete(label)
    }
  }

  public finish(partial = false): Nullable<ProjectTextEncoding> {
    if (!partial) {
      for (const [label, decoder] of this.decoders) {
        if (validateTextChunk(decoder, new Uint8Array(), false)) this.decoders.delete(label)
      }
    }
    const head = Buffer.from(this.head.subarray(0, this.headLength))
    if (startsWithBytes(head, UTF8_BOM))
      return this.decoders.has('utf-8') ? 'utf8-bom' : null
    if (startsWithBytes(head, UTF16LE_BOM))
      return this.decoders.has('utf-16le') ? 'utf16le' : null
    if (startsWithBytes(head, UTF16BE_BOM))
      return this.decoders.has('utf-16be') ? 'utf16be' : null
    const utf16 = detectUtf16NoBom(head)
    if (utf16)
      return this.decoders.has(utf16 === 'utf16le-nobom' ? 'utf-16le' : 'utf-16be') ? utf16 : null
    if (this.hasNul) return null
    if (this.decoders.has('utf-8')) return 'utf8'
    if (this.decoders.has('gb18030')) return 'gb18030'
    return null
  }
}

export function detectProjectTextEncoding(
  data: Buffer | Uint8Array,
  partial = false,
): Nullable<ProjectTextEncoding> {
  const probe = new ProjectTextEncodingProbe()
  probe.push(data)
  return probe.finish(partial)
}

function startsWithBytes(buffer: Uint8Array, prefix: Uint8Array): boolean {
  if (buffer.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (buffer[index] !== prefix[index]) return false
  }
  return true
}

function prefixBytes(prefix: Uint8Array, payload: Buffer): Buffer {
  const combined = new Uint8Array(prefix.length + payload.length)
  combined.set(prefix, 0)
  combined.set(payload, prefix.length)
  return Buffer.from(combined)
}

function detectUtf16NoBom(buffer: Buffer): Nullable<ProjectTextEncoding> {
  let checkLength = Math.min(buffer.length, 8192)
  checkLength -= checkLength % 2
  if (checkLength < 2) return null
  if (checkLength < 16) {
    // 极短无 BOM 文本只接受可验证的 ASCII 与交错 NUL，纯非 ASCII 不凭长度猜字节序。
    const asciiUnit = (unit: number) => unit === 9 || unit === 10 || unit === 13 || (unit >= 32 && unit <= 126)
    let little = true
    let big = true
    for (let index = 0; index < checkLength; index += 2) {
      little &&= buffer[index + 1] === 0 && asciiUnit(buffer[index])
      big &&= buffer[index] === 0 && asciiUnit(buffer[index + 1])
    }
    return little ? 'utf16le-nobom' : big ? 'utf16be-nobom' : null
  }

  let evenNul = 0
  let oddNul = 0
  for (let index = 0; index < checkLength; index += 1) {
    if (buffer[index] !== 0) continue
    if (index % 2 === 0) {
      evenNul += 1
    } else {
      oddNul += 1
    }
  }

  const half = checkLength / 2
  if (oddNul * 10 >= half * 3 && evenNul * 20 <= half) return 'utf16le-nobom'
  if (evenNul * 10 >= half * 3 && oddNul * 20 <= half) return 'utf16be-nobom'
  return null
}

function encodeUtf16Be(content: string): Buffer {
  const le = Buffer.from(content, 'utf16le')
  const swapped = new Uint8Array(le.length)
  for (let index = 0; index < le.length; index += 2) {
    swapped[index] = le[index + 1] ?? 0
    swapped[index + 1] = le[index] ?? 0
  }
  return Buffer.from(swapped)
}

function decodeGb18030(buffer: Buffer): string {
  return new TextDecoder('gb18030', { fatal: false }).decode(buffer)
}

function encodeGb18030(content: string): Buffer {
  const encoded = iconv.encode(content, 'gb18030')
  if (decodeGb18030(encoded) !== content)
    throw new ProjectError('INVALID_INPUT', '该文本无法按当前 GB18030 编码无损写回。')
  return encoded
}

export function offsetToLine(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

export function lineToOffset(content: string, line: number): number {
  if (line <= 1) return 0
  let current = 1
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      current++
      if (current === line) return i + 1
    }
  }
  return content.length
}

export function rangeFromOffsets(content: string, startOffset: number, endOffset: number): Range {
  const startLine = offsetToLine(content, startOffset)
  const endLine = offsetToLine(content, endOffset)
  const startLineOffset = lineToOffset(content, startLine)
  const endLineOffset = lineToOffset(content, endLine)
  const startColumn = startOffset - startLineOffset + 1
  const endColumn = endOffset - endLineOffset + 1
  return {
    startLine,
    endLine,
    startOffset,
    endOffset,
    startColumn: Math.max(1, startColumn),
    endColumn: Math.max(1, endColumn),
  }
}

export function sliceLines(
  content: string,
  startLine?: number,
  endLine?: number,
): { content: string; range: Range } {
  const lines = content.split(/\n/)
  const start = Math.max(1, startLine ?? 1)
  const end = Math.min(lines.length, endLine ?? lines.length)
  const selected = lines.slice(start - 1, end).join('\n')
  return { content: selected, range: { startLine: start, endLine: end } }
}

export function countChangedLines(diff: string): number {
  return diff
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---')),
    ).length
}

export function uniqueIndexOf(content: string, needle: string): { index: number; count: number } {
  if (isEmpty(needle)) return { index: -1, count: 0 }
  let count = 0
  let index = -1
  let from = 0
  while (true) {
    const found = content.indexOf(needle, from)
    if (found === -1) break
    if (count === 0) index = found
    count++
    from = found + Math.max(1, needle.length)
  }
  return { index, count }
}

export interface LineEndingAwareTextMatch {
  index: number
  count: number
  matchedText: string
  replacementText?: string
}

export function resolveLineEndingAwareTextMatch(
  content: string,
  needle: string,
  replacementText?: string,
): LineEndingAwareTextMatch {
  if (shouldTryCrlfMatch(content, needle)) {
    const crlfNeedle = toCrlfText(needle)
    const crlf = uniqueIndexOf(content, crlfNeedle)
    if (crlf.count !== 0)
      return {
        ...crlf,
        matchedText: crlfNeedle,
        replacementText: isPresent(replacementText) ? toCrlfText(replacementText) : replacementText,
      }
  }

  const direct = uniqueIndexOf(content, needle)
  return { ...direct, matchedText: needle, replacementText }
}

export function includesLineEndingAware(content: string, needle: string): boolean {
  return resolveLineEndingAwareTextMatch(content, needle).count > 0
}

export function adaptTextToContentLineEndings(content: string, text: string): string {
  return shouldTryCrlfMatch(content, text) ? toCrlfText(text) : text
}

function shouldTryCrlfMatch(content: string, needle: string): boolean {
  return content.includes('\r\n') && needle.includes('\n') && !needle.includes('\r\n')
}

function toCrlfText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}
