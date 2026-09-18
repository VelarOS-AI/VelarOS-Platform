import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryContentKeyServiceOptionsV2,
  MemoryContentPayloadV2,
  MemorySealedContentV2,
} from '../../../types/tree-v2/storage.js'
import { canonicalStringifyV2 } from '../../../utils/tree-v2/diff-chain.js'
import { generateMemoryBlobIdV2 } from '../../../utils/tree-v2/storage/blob-id.js'
import {
  ContentCommitmentPatternV2,
  contentEnvelopeAadV2,
  ContentEnvelopeAlgorithmV2,
  ContentEnvelopeFormatV2,
  ContentPayloadFormatV2,
  createContentCommitmentV2,
  decodeContentBase64V2,
  parseContentEnvelopeV2,
  verifyContentCommitmentV2,
} from '../../../utils/tree-v2/storage/content-key.js'
import { MemoryStorageErrorCodesV2 } from '../../../utils/tree-v2/storage/error-codes.js'

import type { MemoryBlobStoreV2Api } from './MemoryBlobStoreV2.js'
import type { MemoryKeyringStoreV2Api } from './MemoryKeyringStoreV2.js'

/**
 * per-blob DEK 的唯一 owner：生成、包装、解包、AES-256-GCM 信封、承诺 nonce 与 crypto-shred。
 *
 * 调用方只拿得到 blob id、承诺与解密后的正文；DEK 与承诺 nonce 不跨出这个类。
 * 实例归 `MemorySystemRuntimeV2`（或探针）所有，与一份 keyring、一个 blob 目录成组。
 */
export interface ContentKeyServiceV2Api {
  /**
   * 封存一段正文：随机 blob id 与 DEK → GCM 信封 → 登记 DEK → 写 blob。
   * 返回 blob id、随机化承诺与明文字节数；写 blob 失败会回滚刚登记的 DEK。
   */
  sealContent(content: Buffer | string): MemorySealedContentV2
  /**
   * 按承诺取回正文：解 DEK → 验 GCM tag → 常数时间比对承诺。
   * 承诺形态非法抛 VALIDATION，密钥已销毁抛 MEMORY_DEK_DESTROYED，
   * 信封坏抛 MEMORY_BLOB_CORRUPTED，承诺不符抛 MEMORY_COMMITMENT_MISMATCH。
   */
  openContent(blobId: string, expectedCommitment: string): Buffer
  /**
   * 擦除一段正文：先销毁 DEK（这一刻起内容不可恢复），再删物理 blob。
   * 返回这次是不是真的销毁了一把还在的密钥。
   */
  eraseContent(blobId: string): boolean
}

export class ContentKeyServiceV2 implements ContentKeyServiceV2Api {
  /** DEK、承诺 nonce 的字节长度（AES-256 与 HMAC-SHA256 的密钥长度）。 */
  private static readonly KeyByteLength = 32

  /** GCM IV 的字节长度。 */
  private static readonly IvByteLength = 12

  /** GCM tag 的字节长度。 */
  private static readonly TagByteLength = 16

  /** 信封算法名，传给 node:crypto。 */
  private static readonly CipherAlgorithm = 'aes-256-gcm'

  private readonly random: (byteLength: number) => Buffer

  constructor(
    private readonly keyring: MemoryKeyringStoreV2Api,
    private readonly blobs: MemoryBlobStoreV2Api,
    options: MemoryContentKeyServiceOptionsV2 = {}
  ) {
    this.random = options.random ?? randomBytes
  }

  public sealContent(content: Buffer | string): MemorySealedContentV2 {
    const contentBytes = isString(content) ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const blobId = generateMemoryBlobIdV2(this.random)
    const dek = this.randomExact(ContentKeyServiceV2.KeyByteLength)
    const commitmentNonce = this.randomExact(ContentKeyServiceV2.KeyByteLength)
    const iv = this.randomExact(ContentKeyServiceV2.IvByteLength)
    const commitment = createContentCommitmentV2(commitmentNonce, contentBytes)

    try {
      const payload: MemoryContentPayloadV2 = {
        format: ContentPayloadFormatV2,
        commitmentNonce: commitmentNonce.toString('base64'),
        content: contentBytes.toString('base64'),
      }
      const cipher = createCipheriv(ContentKeyServiceV2.CipherAlgorithm, dek, iv)
      cipher.setAAD(contentEnvelopeAadV2(blobId))
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(canonicalStringifyV2(payload), 'utf8')),
        cipher.final(),
      ])
      const envelope = {
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
    if (!ContentCommitmentPatternV2.test(expectedCommitment)) {
      throw new AppError('VALIDATION', 'content commitment 形态非法。')
    }
    const dek = this.keyring.getContentDek(blobId)
    try {
      const envelope = parseContentEnvelopeV2(this.blobs.readBlob(blobId))
      const iv = decodeContentBase64V2(envelope.iv, 'content envelope iv')
      const tag = decodeContentBase64V2(envelope.tag, 'content envelope tag')
      const ciphertext = decodeContentBase64V2(envelope.ciphertext, 'content envelope ciphertext')
      if (
        iv.length !== ContentKeyServiceV2.IvByteLength ||
        tag.length !== ContentKeyServiceV2.TagByteLength
      ) {
        throw new AppError(
          MemoryStorageErrorCodesV2.blobCorrupted,
          'content envelope IV/tag 长度非法。'
        )
      }

      let plaintext: Buffer
      try {
        const decipher = createDecipheriv(ContentKeyServiceV2.CipherAlgorithm, dek, iv)
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
        return verifyContentCommitmentV2(
          plaintext,
          blobId,
          expectedCommitment,
          ContentKeyServiceV2.KeyByteLength
        )
      } finally {
        plaintext.fill(0)
      }
    } finally {
      dek.fill(0)
    }
  }

  /**
   * 删除顺序刻意是 key first：destroyContentDek 成功即内容不可恢复；物理 blob 删除失败只留
   * 无密钥密文，后台可重试卫生清理，不会把"删除文件成功"误当 crypto-shred 生效点。
   */
  public eraseContent(blobId: string): boolean {
    const destroyed = this.keyring.destroyContentDek(blobId)
    this.blobs.destroyBlob(blobId)
    return destroyed
  }


  /** 从注入的随机源取指定长度的字节；长度不对就是随机源坏了，抛 INVARIANT。 */
  private randomExact(byteLength: number): Buffer {
    const value = this.random(byteLength)
    if (!Buffer.isBuffer(value) || value.length !== byteLength) {
      throw new AppError('INVARIANT', 'ContentKeyService 随机源返回长度错误。')
    }
    return Buffer.from(value)
  }
}
