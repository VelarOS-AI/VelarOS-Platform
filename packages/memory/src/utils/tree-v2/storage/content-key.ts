import { createHmac, timingSafeEqual } from 'node:crypto'

import { isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryContentEnvelopeV2,
  MemoryContentPayloadV2,
} from '../../../types/tree-v2/storage'
import { isStrictRecordV2 } from '../checks'

import { MemoryStorageErrorCodesV2 } from './error-codes'
import { decodeCanonicalBase64V2 } from './wrapping-root'

/**
 * 密文正文的格式身份、承诺算法与严格解析。
 * 格式身份是算法里的常量，跟着规则留在这里，不进合同也不进可调参数表。
 */

/** 承诺 HMAC 的域分隔串。 */
export const ContentCommitmentDomainV2 = 'velaros.memory.content-commitment.v2'

/** 解密后载荷的格式身份。 */
export const ContentPayloadFormatV2 = 'velaros.memory.content.v2'

/** 磁盘上信封的格式身份。 */
export const ContentEnvelopeFormatV2 = 'velaros.memory.envelope.v2'

/** 信封算法身份。 */
export const ContentEnvelopeAlgorithmV2 = 'A256GCM'

/** 承诺的形态：`c2:` 加 64 位小写 hex。 */
export const ContentCommitmentPatternV2 = /^c2:[0-9a-f]{64}$/

/** 用随机 nonce 对正文算随机化结构承诺；nonce 必须是 32 字节。 */
export function createContentCommitmentV2(nonce: Buffer, content: Buffer): string {
  if (nonce.length !== 32) {
    throw new AppError('VALIDATION', 'content commitment nonce 必须是 32 字节。')
  }
  const message = Buffer.concat([
    Buffer.from(ContentCommitmentDomainV2, 'utf8'),
    Buffer.from([0]),
    content,
  ])
  return `c2:${createHmac('sha256', nonce).update(message).digest('hex')}`
}

/** 常数时间比较两个承诺；形态不合规直接判不等，不泄露比较位置。 */
export function constantTimeCommitmentEqualV2(left: string, right: string): boolean {
  if (!ContentCommitmentPatternV2.test(left) || !ContentCommitmentPatternV2.test(right)) return false
  const leftBytes = Buffer.from(left.slice(3), 'hex')
  const rightBytes = Buffer.from(right.slice(3), 'hex')
  return timingSafeEqual(leftBytes, rightBytes)
}

/** 这个 blob 的信封 GCM 附加认证数据：格式身份加 blob id，防止跨 blob 替换。 */
export function contentEnvelopeAadV2(blobId: string): Buffer {
  return Buffer.from(`${ContentEnvelopeFormatV2}\0${blobId}`, 'utf8')
}

/** 解一段规范 base64，失败统一报成 blob 损坏（错误面不带明文）。 */
export function decodeContentBase64V2(value: string, label: string): Buffer {
  try {
    return decodeCanonicalBase64V2(value, label)
  } catch (error) {
    throw new AppError(MemoryStorageErrorCodesV2.blobCorrupted, `${label} 不是规范 base64。`, error)
  }
}

/** 严格解析磁盘上的信封 JSON：未知字段、缺字段、非纯对象一律判损坏。 */
export function parseContentEnvelopeV2(raw: Buffer): MemoryContentEnvelopeV2 {
  const parsed = parseStrictContentJsonV2(raw, [
    'format',
    'algorithm',
    'iv',
    'tag',
    'ciphertext',
  ])
  if (
    parsed['format'] !== ContentEnvelopeFormatV2 ||
    parsed['algorithm'] !== ContentEnvelopeAlgorithmV2 ||
    !isString(parsed['iv']) ||
    !isString(parsed['tag']) ||
    !isString(parsed['ciphertext'])
  ) {
    throw new AppError(MemoryStorageErrorCodesV2.blobCorrupted, 'content envelope 字段非法。')
  }
  return {
    format: ContentEnvelopeFormatV2,
    algorithm: ContentEnvelopeAlgorithmV2,
    iv: parsed['iv'],
    tag: parsed['tag'],
    ciphertext: parsed['ciphertext'],
  }
}

/** 严格解析解密后的载荷 JSON：字段集与格式身份都要对上，否则判损坏。 */
export function parseContentPayloadV2(raw: Buffer): MemoryContentPayloadV2 {
  const parsed = parseStrictContentJsonV2(raw, ['format', 'commitmentNonce', 'content'])
  if (
    parsed['format'] !== ContentPayloadFormatV2 ||
    !isString(parsed['commitmentNonce']) ||
    !isString(parsed['content'])
  ) {
    throw new AppError(MemoryStorageErrorCodesV2.blobCorrupted, 'content payload 字段非法。')
  }
  return {
    format: ContentPayloadFormatV2,
    commitmentNonce: parsed['commitmentNonce'],
    content: parsed['content'],
  }
}

/**
 * 解出载荷、常数时间比对承诺，验过才把正文交出去。
 * nonce 长度不对或承诺不符都抛错，并先把已解出的字节清零——未验证的正文绝不外泄。
 */
export function verifyContentCommitmentV2(
  plaintext: Buffer,
  blobId: string,
  expectedCommitment: string,
  nonceByteLength: number
): Buffer {
  const payload = parseContentPayloadV2(plaintext)
  const nonce = decodeContentBase64V2(payload.commitmentNonce, 'content commitment nonce')
  const content = decodeContentBase64V2(payload.content, 'content bytes')
  let verified = false
  try {
    if (nonce.length !== nonceByteLength) {
      throw new AppError(
        MemoryStorageErrorCodesV2.blobCorrupted,
        'content commitment nonce 长度非法。'
      )
    }
    if (
      !constantTimeCommitmentEqualV2(
        createContentCommitmentV2(nonce, content),
        expectedCommitment
      )
    ) {
      throw new AppError(
        MemoryStorageErrorCodesV2.commitmentMismatch,
        '解密正文与结构承诺不一致。',
        undefined,
        { blobId }
      )
    }
    verified = true
    return content
  } finally {
    nonce.fill(0)
    if (!verified) content.fill(0)
  }
}

/** 解 JSON 并要求键集恰好等于 expectedKeys；宽容解析是伪造注入面，一律不给。 */
export function parseStrictContentJsonV2(
  raw: Buffer,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    throw new AppError(
      MemoryStorageErrorCodesV2.blobCorrupted,
      'content envelope JSON 无法解析。',
      error
    )
  }
  if (!isStrictRecordV2(parsed, expectedKeys)) {
    throw new AppError(
      MemoryStorageErrorCodesV2.blobCorrupted,
      'content envelope 含未知或缺失字段。'
    )
  }
  return parsed
}
