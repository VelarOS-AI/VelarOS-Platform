import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import { canonicalStringifyV2 } from '../DiffChain'

import { fsyncDirectoryV2, writeFileAtomicV2 } from './AtomicFile'
import { MemoryStorageErrorCodesV2 } from './ErrorCodes'
import {
  commitCurrentGenerationV2,
  listGenerationEntriesV2,
  readCurrentGenerationV2,
} from './GenerationPointer'
import { type MemoryKeyringStoreV2 } from './Keyring'
import { indexGenerationDirV2 } from './PhysicalRoots'
import { decodeCanonicalBase64V2 } from './WrappingRoot'

const IndexEnvelopeFormatV2 = 'velaros.memory.index-generation.v2'
const IndexEnvelopeAlgorithmV2 = 'A256GCM'
const IndexArtifactFileNameV2 = 'index-generation.sealed'

export const MemoryIndexStoragePolicyV2 = Object.freeze({
  strategy: 'aes-256-gcm-generation-envelope',
  buildMode: 'memory-only',
  commitMode: 'atomic-seal-then-current',
  plaintextAtRest: false,
  plaintextWalAllowed: false,
} as const)

interface MemoryIndexGenerationEnvelopeV2 {
  readonly format: typeof IndexEnvelopeFormatV2
  readonly generation: number
  readonly algorithm: typeof IndexEnvelopeAlgorithmV2
  readonly iv: string
  readonly tag: string
  readonly ciphertext: string
}

export interface MemoryIndexGenerationSealReportV2 {
  readonly generation: number
  readonly encryptedByteLength: number
  readonly replacedGeneration: number | null
}

/**
 * 派生 index generation 的文件级静态加密边界。
 *
 * 生成器必须在内存中构建可序列化产物，再把整代交给本函数封存。磁盘上只出现
 * AES-256-GCM 信封；不会产生明文 SQLite/WAL/临时文件。CURRENT 只在信封 fsync 后切换。
 */
export function sealMemoryIndexGenerationV2(
  indexDir: string,
  generation: number,
  plaintextArtifact: Buffer,
  keyring: MemoryKeyringStoreV2,
  random: (byteLength: number) => Buffer = randomBytes
): MemoryIndexGenerationSealReportV2 {
  assertGenerationV2(generation)
  const generationDir = indexGenerationDirV2(indexDir, generation)
  if (existsSync(generationDir)) {
    throw new AppError('INVARIANT', 'index generation 目录已存在，禁止原位覆盖。', undefined, {
      generation,
    })
  }

  const previousGeneration = readCurrentGenerationV2(indexDir)
  const key = keyring.getOrCreateIndexGenerationKey(generation)
  const iv = Buffer.from(random(12))
  if (iv.length !== 12) {
    key.fill(0)
    throw new AppError('INVARIANT', 'index generation 随机源必须返回 12 字节 IV。')
  }

  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(indexGenerationAadV2(generation))
    const ciphertext = Buffer.concat([cipher.update(plaintextArtifact), cipher.final()])
    const envelope: MemoryIndexGenerationEnvelopeV2 = {
      format: IndexEnvelopeFormatV2,
      generation,
      algorithm: IndexEnvelopeAlgorithmV2,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }

    mkdirSync(generationDir)
    try {
      writeFileAtomicV2(
        join(generationDir, IndexArtifactFileNameV2),
        canonicalStringifyV2(envelope),
        { label: `index-generation-${generation}` }
      )
      fsyncDirectoryV2(generationDir)
      commitCurrentGenerationV2(indexDir, generation, {
        label: 'index-current',
      })
    } catch (error) {
      rmSync(generationDir, { recursive: true, force: true })
      keyring.destroyIndexGenerationKey(generation)
      throw error
    }

    return {
      generation,
      encryptedByteLength: ciphertext.length,
      replacedGeneration: previousGeneration,
    }
  } finally {
    key.fill(0)
    iv.fill(0)
  }
}

/** 只在内存中解封当前派生代；调用方负责尽快清零返回 Buffer。 */
export function openCurrentMemoryIndexGenerationV2(
  indexDir: string,
  keyring: MemoryKeyringStoreV2
): { generation: number; plaintextArtifact: Buffer } | null {
  const generation = readCurrentGenerationV2(indexDir)
  if (generation === null) return null
  const generationDir = indexGenerationDirV2(indexDir, generation)
  const artifactPath = join(generationDir, IndexArtifactFileNameV2)
  if (!existsSync(artifactPath)) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'CURRENT 指向的 index generation 缺少密文产物。',
      undefined,
      { generation }
    )
  }

  const envelope = parseIndexEnvelopeV2(readFileSync(artifactPath, 'utf8'), generation)
  const key = keyring.getIndexGenerationKey(generation)
  const iv = decodeCanonicalBase64V2(envelope.iv, 'index generation iv')
  const tag = decodeCanonicalBase64V2(envelope.tag, 'index generation tag')
  const ciphertext = decodeCanonicalBase64V2(envelope.ciphertext, 'index generation ciphertext')
  try {
    if (iv.length !== 12 || tag.length !== 16) {
      throw new AppError(
        MemoryStorageErrorCodesV2.corruption,
        'index generation IV/tag 长度非法。',
        undefined,
        { generation }
      )
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(indexGenerationAadV2(generation))
    decipher.setAuthTag(tag)
    try {
      return {
        generation,
        plaintextArtifact: Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      }
    } catch (error) {
      throw new AppError(
        MemoryStorageErrorCodesV2.corruption,
        'index generation GCM 完整性校验失败。',
        error,
        { generation }
      )
    }
  } finally {
    key.fill(0)
    iv.fill(0)
    tag.fill(0)
    ciphertext.fill(0)
  }
}

/**
 * CURRENT 之外的旧代/残留代可在新代验证后清理。先删目录，再销毁该代 key；
 * 若目录删除失败则保留 key 便于诊断，不能制造“文件仍在但误报已销毁”的状态。
 */
export function pruneMemoryIndexGenerationsV2(
  indexDir: string,
  keyring: MemoryKeyringStoreV2
): readonly number[] {
  const current = readCurrentGenerationV2(indexDir)
  if (current === null) return []
  const removed: number[] = []
  for (const entry of listGenerationEntriesV2(indexDir, {
    suffix: '',
    kind: 'directory',
  })) {
    if (entry.generation === current) continue
    rmSync(entry.path, { recursive: true, force: true })
    fsyncDirectoryV2(indexDir)
    keyring.destroyIndexGenerationKey(entry.generation)
    removed.push(entry.generation)
  }
  return removed
}

function parseIndexEnvelopeV2(
  raw: string,
  expectedGeneration: number
): MemoryIndexGenerationEnvelopeV2 {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'index generation 信封 JSON 无法解析。',
      error
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError(MemoryStorageErrorCodesV2.corruption, 'index generation 信封必须是对象。')
  }
  const record = parsed as Record<string, unknown>
  const expectedKeys = ['algorithm', 'ciphertext', 'format', 'generation', 'iv', 'tag']
  const actualKeys = Object.keys(record).sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index]) ||
    record['format'] !== IndexEnvelopeFormatV2 ||
    record['generation'] !== expectedGeneration ||
    record['algorithm'] !== IndexEnvelopeAlgorithmV2 ||
    typeof record['iv'] !== 'string' ||
    typeof record['tag'] !== 'string' ||
    typeof record['ciphertext'] !== 'string'
  ) {
    throw new AppError(
      MemoryStorageErrorCodesV2.corruption,
      'index generation 信封字段非法或含未知字段。',
      undefined,
      { expectedGeneration }
    )
  }
  return {
    format: IndexEnvelopeFormatV2,
    generation: expectedGeneration,
    algorithm: IndexEnvelopeAlgorithmV2,
    iv: record['iv'] as string,
    tag: record['tag'] as string,
    ciphertext: record['ciphertext'] as string,
  }
}

function indexGenerationAadV2(generation: number): Buffer {
  return Buffer.from(`${IndexEnvelopeFormatV2}\0${generation}`, 'utf8')
}

function assertGenerationV2(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new AppError('VALIDATION', 'index generation 必须是正整数。', undefined, {
      generation,
    })
  }
}
