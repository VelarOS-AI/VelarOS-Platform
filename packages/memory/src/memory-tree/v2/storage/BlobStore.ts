import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import {
  fsyncDirectoryV2,
  removeStaleTempFilesV2,
  type StorageStepHooksV2,
  writeFileAtomicV2,
} from './AtomicFile'

/**
 * 密文 blob 存储（WS3-S1，规范 §7.1 冻结）。
 *
 * - **blob_id 禁内容寻址**（规范冻结条款）：content-addressed id 是明文派生指纹
 *   （同内容跨行同 id 即泄露等值关系），id 一律 128-bit CSPRNG 随机 32 hex。
 * - 布局：`blobs/<id 前 2 hex>/<id>.blob`，两级分片防单目录膨胀。
 * - 写入原子（temp + rename + fsync）、**只写一次**（blob 不可变，覆盖 = 不变量破坏）。
 * - 本层只管密文字节的存取与销毁；信封内容的完整性由 GCM tag 在解密时验证
 *   （ContentKeyService），内容不可恢复性由 crypto-shred（销毁 DEK）保证——
 *   `destroyBlob` 的物理删除是卫生动作，不是擦除语义的承担者。
 */

export const MemoryBlobIdPatternV2 = /^[0-9a-f]{32}$/

/** 生成随机 blob_id（128-bit CSPRNG → 32 hex）。 */
export function generateMemoryBlobIdV2(random: (byteLength: number) => Buffer = randomBytes): string {
  const id = random(16).toString('hex')
  assertMemoryBlobIdV2(id)
  return id
}

/** blob_id 形态校验（兼作路径穿越防御：id 是路径组件，非法形态一律拒绝）。 */
export function assertMemoryBlobIdV2(blobId: string): void {
  if (!MemoryBlobIdPatternV2.test(blobId)) {
    throw new AppError('VALIDATION', 'blob_id 必须是 32 位小写 hex 随机标识。')
  }
}

export class MemoryBlobStoreV2 {
  private readonly blobsDir: string
  private readonly hooks: StorageStepHooksV2 | undefined

  constructor(blobsDir: string, options: { hooks?: StorageStepHooksV2 } = {}) {
    this.blobsDir = blobsDir
    this.hooks = options.hooks
  }

  public pathForBlob(blobId: string): string {
    assertMemoryBlobIdV2(blobId)
    return join(this.blobsDir, blobId.slice(0, 2), `${blobId}.blob`)
  }

  public hasBlob(blobId: string): boolean {
    return existsSync(this.pathForBlob(blobId))
  }

  /** 原子写入密文信封。blob 不可变：目标已存在即 INVARIANT 拒绝。 */
  public writeBlob(blobId: string, envelope: Buffer): void {
    const blobPath = this.pathForBlob(blobId)
    if (existsSync(blobPath)) {
      throw new AppError('INVARIANT', 'blob 只写一次，禁止覆盖已存在的密文。', undefined, { blobId })
    }
    mkdirSync(dirname(blobPath), { recursive: true })
    writeFileAtomicV2(blobPath, envelope, { label: `blob-${blobId}`, hooks: this.hooks })
  }

  /** 读取密文信封字节；缺失即 NOT_FOUND。完整性验证（GCM tag）发生在解密层。 */
  public readBlob(blobId: string): Buffer {
    const blobPath = this.pathForBlob(blobId)
    if (!existsSync(blobPath)) {
      throw new AppError('NOT_FOUND', '指定 blob 不存在。', undefined, { blobId })
    }
    return readFileSync(blobPath)
  }

  /** 物理销毁密文（幂等：不存在即 no-op）。内容不可恢复性由 crypto-shred 承担。 */
  public destroyBlob(blobId: string): void {
    const blobPath = this.pathForBlob(blobId)
    if (!existsSync(blobPath)) return
    rmSync(blobPath, { force: true })
    fsyncDirectoryV2(dirname(blobPath))
  }

  /** 仅供 package-owned orphan recovery / 诊断使用；返回经过形态校验的物理 blob id。 */
  public listBlobIds(): readonly string[] {
    if (!existsSync(this.blobsDir)) return []
    const ids: string[] = []
    for (const shard of readdirSync(this.blobsDir, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue
      const shardDir = join(this.blobsDir, shard.name)
      for (const entry of readdirSync(shardDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.blob')) continue
        const blobId = entry.name.slice(0, -'.blob'.length)
        assertMemoryBlobIdV2(blobId)
        if (blobId.slice(0, 2) !== shard.name) {
          throw new AppError('INVARIANT', 'blob 文件所在分片与 blob_id 不一致。', undefined, {
            blobId,
            shard: shard.name,
          })
        }
        ids.push(blobId)
      }
    }
    return ids.sort()
  }

  /** 清理崩溃残留（分片目录内的 *.tmp），返回清理数量。 */
  public cleanupResidue(): number {
    let removed = removeStaleTempFilesV2(this.blobsDir)
    if (!existsSync(this.blobsDir)) return removed
    for (const entry of readdirSync(this.blobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue
      removed += removeStaleTempFilesV2(join(this.blobsDir, entry.name))
    }
    return removed
  }
}
