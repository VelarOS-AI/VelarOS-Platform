import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

import { isNotNull, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { canonicalStringifyV2 } from '../DiffChain'

import { generateMemoryBlobIdV2, type MemoryBlobStoreV2 } from './BlobStore'
import { MemoryStorageErrorCodesV2 } from './ErrorCodes'
import { type MemoryKeyringStoreV2 } from './Keyring'
import { decodeCanonicalBase64V2 } from './WrappingRoot'

const ContentCommitmentDomainV2 = 'velaros.memory.content-commitment.v2'
const ContentPayloadFormatV2 = 'velaros.memory.content.v2'
const ContentEnvelopeFormatV2 = 'velaros.memory.envelope.v2'
const ContentEnvelopeAlgorithmV2 = 'A256GCM'
const CommitmentPatternV2 = /^c2:[0-9a-f]{64}$/

interface MemoryContentPayloadV2 {
  readonly format: typeof ContentPayloadFormatV2
  readonly commitmentNonce: string
  readonly content: string
}

interface MemoryContentEnvelopeV2 {
  readonly format: typeof ContentEnvelopeFormatV2
  readonly algorithm: typeof ContentEnvelopeAlgorithmV2
  readonly iv: string
  readonly tag: string
  readonly ciphertext: string
}

export interface MemorySealedContentV2 {
  readonly blobId: string
  readonly commitment: string
  readonly byteLength: number
}

export interface MemoryContentKeyServiceOptionsV2 {
  readonly random?: (byteLength: number) => Buffer
}

/**
 * per-blob DEK 的唯一 owner：生成/包装/解包、AES-256-GCM 信封、承诺 nonce 与 crypto-shred。
 * 调用方只拿 blob id、承诺和解密后的正文；DEK 与 commitment nonce 不跨出本服务。
 */
export class ContentKeyServiceV2 {
  private readonly random: (byteLength: number) => Buffer

  constructor(
    private readonly keyring: MemoryKeyringStoreV2,
    private readonly blobs: MemoryBlobStoreV2,
    options: MemoryContentKeyServiceOptionsV2 = {}
  ) {
    this.random = options.random ?? randomBytes
  }

  public sealContent(content: Buffer | string): MemorySealedContentV2 {
    const contentBytes = isString(content) ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const blobId = generateMemoryBlobIdV2(this.random)
    const dek = this.randomExact(32)
    const commitmentNonce = this.randomExact(32)
    const iv = this.randomExact(12)
    const commitment = createContentCommitmentV2(commitmentNonce, contentBytes)

    try {
      const payload: MemoryContentPayloadV2 = {
        format: ContentPayloadFormatV2,
        commitmentNonce: commitmentNonce.toString('base64'),
        content: contentBytes.toString('base64'),
      }
      const cipher = createCipheriv('aes-256-gcm', dek, iv)
      cipher.setAAD(contentEnvelopeAadV2(blobId))
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(canonicalStringifyV2(payload), 'utf8')),
        cipher.final(),
      ])
      const envelope: MemoryContentEnvelopeV2 = {
        format: ContentEnvelopeFormatV2,
        algorithm: ContentEnvelopeAlgorithmV2,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }

      this.keyring.addContentDek(blobId, dek)
      try {
        this.blobs.writeBlob(blobId, Buffer.from(canonicalStringifyV2(envelope), 'utf8'))
      } catch (error) {
        this.keyring.destroyContentDek(blobId)
        throw error
      }
      return { blobId, commitment, byteLength: contentBytes.length }
    } finally {
      contentBytes.fill(0)
      dek.fill(0)
      commitmentNonce.fill(0)
      iv.fill(0)
    }
  }

  public openContent(blobId: string, expectedCommitment: string): Buffer {
    if (!CommitmentPatternV2.test(expectedCommitment)) {
      throw new AppError('VALIDATION', 'content commitment 形态非法。')
    }
    const dek = this.keyring.getContentDek(blobId)
    try {
      const envelope = parseContentEnvelopeV2(this.blobs.readBlob(blobId))
      const iv = decodeContentBase64V2(envelope.iv, 'content envelope iv')
      const tag = decodeContentBase64V2(envelope.tag, 'content envelope tag')
      const ciphertext = decodeContentBase64V2(envelope.ciphertext, 'content envelope ciphertext')
      if (iv.length !== 12 || tag.length !== 16) {
        throw new AppError(
          MemoryStorageErrorCodesV2.blobCorrupted,
          'content envelope IV/tag 长度非法。'
        )
      }

      let plaintext: Buffer
      try {
        const decipher = createDecipheriv('aes-256-gcm', dek, iv)
        decipher.setAAD(contentEnvelopeAadV2(blobId))
        decipher.setAuthTag(tag)
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      } catch (error) {
        throw new AppError(
          MemoryStorageErrorCodesV2.blobCorrupted,
          'content envelope GCM 完整性校验失败。',
          error,
          { blobId }
        )
      }
      try {
        const payload = parseContentPayloadV2(plaintext)
        const nonce = decodeContentBase64V2(payload.commitmentNonce, 'content commitment nonce')
        const content = decodeContentBase64V2(payload.content, 'content bytes')
        let verified = false
        try {
          if (nonce.length !== 32) {
            throw new AppError(
              MemoryStorageErrorCodesV2.blobCorrupted,
              'content commitment nonce 长度非法。'
            )
          }
          const actualCommitment = createContentCommitmentV2(nonce, content)
          if (!constantTimeCommitmentEqualV2(actualCommitment, expectedCommitment)) {
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
      } finally {
        plaintext.fill(0)
      }
    } finally {
      dek.fill(0)
    }
  }

  /**
   * 删除顺序刻意是 key first：destroyContentDek 成功即内容不可恢复；物理 blob 删除失败只留
   * 无密钥密文，后台可重试卫生清理，不会把“删除文件成功”误当 crypto-shred 生效点。
   */
  public eraseContent(blobId: string): boolean {
    const destroyed = this.keyring.destroyContentDek(blobId)
    this.blobs.destroyBlob(blobId)
    return destroyed
  }

  private randomExact(byteLength: number): Buffer {
    const value = this.random(byteLength)
    if (!Buffer.isBuffer(value) || value.length !== byteLength) {
      throw new AppError('INVARIANT', 'ContentKeyService 随机源返回长度错误。')
    }
    return Buffer.from(value)
  }
}

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

function constantTimeCommitmentEqualV2(left: string, right: string): boolean {
  if (!CommitmentPatternV2.test(left) || !CommitmentPatternV2.test(right)) return false
  const leftBytes = Buffer.from(left.slice(3), 'hex')
  const rightBytes = Buffer.from(right.slice(3), 'hex')
  return timingSafeEqual(leftBytes, rightBytes)
}

function contentEnvelopeAadV2(blobId: string): Buffer {
  return Buffer.from(`${ContentEnvelopeFormatV2}\0${blobId}`, 'utf8')
}

function decodeContentBase64V2(value: string, label: string): Buffer {
  try {
    return decodeCanonicalBase64V2(value, label)
  } catch (error) {
    throw new AppError(MemoryStorageErrorCodesV2.blobCorrupted, `${label} 不是规范 base64。`, error)
  }
}

function parseContentEnvelopeV2(raw: Buffer): MemoryContentEnvelopeV2 {
  const parsed = parseStrictJsonV2(raw, ['format', 'algorithm', 'iv', 'tag', 'ciphertext'])
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
    iv: parsed['iv'] as string,
    tag: parsed['tag'] as string,
    ciphertext: parsed['ciphertext'] as string,
  }
}

function parseContentPayloadV2(raw: Buffer): MemoryContentPayloadV2 {
  const parsed = parseStrictJsonV2(raw, ['format', 'commitmentNonce', 'content'])
  if (
    parsed['format'] !== ContentPayloadFormatV2 ||
    !isString(parsed['commitmentNonce']) ||
    !isString(parsed['content'])
  ) {
    throw new AppError(MemoryStorageErrorCodesV2.blobCorrupted, 'content payload 字段非法。')
  }
  return {
    format: ContentPayloadFormatV2,
    commitmentNonce: parsed['commitmentNonce'] as string,
    content: parsed['content'] as string,
  }
}

function parseStrictJsonV2(raw: Buffer, expectedKeys: readonly string[]): Record<string, unknown> {
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
  if (!isPlainObject(parsed)) {
    throw new AppError(MemoryStorageErrorCodesV2.blobCorrupted, 'content envelope 必须是纯对象。')
  }
  const prototype: unknown = Object.getPrototypeOf(parsed)
  const record = parsed as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...expectedKeys].sort()
  if (
    (prototype !== Object.prototype && isNotNull(prototype)) ||
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw new AppError(
      MemoryStorageErrorCodesV2.blobCorrupted,
      'content envelope 含未知或缺失字段。'
    )
  }
  return record
}
