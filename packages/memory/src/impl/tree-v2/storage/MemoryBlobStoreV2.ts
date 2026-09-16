import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type { MemoryBlobStoreOptionsV2, StorageStepHooksV2 } from '../../../types/tree-v2/storage'
import {
  fsyncDirectoryV2,
  removeStaleTempFilesV2,
  writeFileAtomicV2,
} from '../../../utils/tree-v2/storage/atomic-file'
import {
  assertMemoryBlobIdV2,
  MemoryBlobFileSuffixV2,
  MemoryBlobShardPatternV2,
} from '../../../utils/tree-v2/storage/blob-id'

/**
 * 密文 blob 的物理 owner：`blobs/<id 前 2 hex>/<id>.blob` 两级分片，写入原子且只写一次。
 *
 * 本层只管密文字节的存取与销毁；信封内容的完整性由 GCM tag 在解密时验证
 * （`ContentKeyServiceV2`），内容不可恢复性由 crypto-shred（销毁 DEK）保证——
 * `destroyBlob` 的物理删除是卫生动作，不是擦除语义的承担者。
 * 实例归创建它的运行时所有，一个 blobs 目录一份。
 */
export interface MemoryBlobStoreV2Api {
  /** 算出这个 blob 的文件路径；id 形态不合规抛 VALIDATION（兼作路径穿越防御）。 */
  pathForBlob(blobId: string): string
  /** 这个 blob 的文件在不在。 */
  hasBlob(blobId: string): boolean
  /** 原子写入密文信封。blob 不可变：目标已存在即抛 INVARIANT。 */
  writeBlob(blobId: string, envelope: Buffer): void
  /** 读密文信封字节；文件缺失抛 NOT_FOUND。完整性验证发生在解密层。 */
  readBlob(blobId: string): Buffer
  /** 物理销毁密文，幂等（不存在即空操作）。内容不可恢复性由 crypto-shred 承担。 */
  destroyBlob(blobId: string): void
  /** 列出物理上存在的 blob id（按名排序），只给包内的孤儿回收与诊断用；分片与 id 不符抛 INVARIANT。 */
  listBlobIds(): readonly string[]
  /** 清理崩溃残留的 `*.tmp`（含分片目录），返回清理数量。 */
  cleanupResidue(): number
}

export class MemoryBlobStoreV2 implements MemoryBlobStoreV2Api {
  private readonly blobsDir: string
  private readonly hooks?: StorageStepHooksV2

  constructor(blobsDir: string, options: MemoryBlobStoreOptionsV2 = {}) {
    this.blobsDir = blobsDir
    this.hooks = options.hooks
  }

  public pathForBlob(blobId: string): string {
    assertMemoryBlobIdV2(blobId)
    return join(this.blobsDir, blobId.slice(0, 2), `${blobId}${MemoryBlobFileSuffixV2}`)
  }

  public hasBlob(blobId: string): boolean {
    return existsSync(this.pathForBlob(blobId))
  }

  public writeBlob(blobId: string, envelope: Buffer): void {
    const blobPath = this.pathForBlob(blobId)
    if (existsSync(blobPath)) {
      throw new AppError('INVARIANT', 'blob 只写一次，禁止覆盖已存在的密文。', undefined, {
        blobId,
      })
    }
    mkdirSync(dirname(blobPath), { recursive: true })
    writeFileAtomicV2(blobPath, envelope, {
      label: `blob-${blobId}`,
      hooks: this.hooks,
    })
  }

  public readBlob(blobId: string): Buffer {
    const blobPath = this.pathForBlob(blobId)
    if (!existsSync(blobPath)) {
      throw new AppError('NOT_FOUND', '指定 blob 不存在。', undefined, {
        blobId,
      })
    }
    return readFileSync(blobPath)
  }

  public destroyBlob(blobId: string): void {
    const blobPath = this.pathForBlob(blobId)
    if (!existsSync(blobPath)) return
    rmSync(blobPath, { force: true })
    fsyncDirectoryV2(dirname(blobPath))
  }

  public listBlobIds(): readonly string[] {
    if (!existsSync(this.blobsDir)) return []
    const ids: string[] = []
    for (const shard of readdirSync(this.blobsDir, { withFileTypes: true })) {
      if (!shard.isDirectory() || !MemoryBlobShardPatternV2.test(shard.name)) continue
      const shardDir = join(this.blobsDir, shard.name)
      for (const entry of readdirSync(shardDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(MemoryBlobFileSuffixV2)) continue
        const blobId = entry.name.slice(0, -MemoryBlobFileSuffixV2.length)
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

  public cleanupResidue(): number {
    let removed = removeStaleTempFilesV2(this.blobsDir)
    if (!existsSync(this.blobsDir)) return removed
    for (const entry of readdirSync(this.blobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !MemoryBlobShardPatternV2.test(entry.name)) continue
      removed += removeStaleTempFilesV2(join(this.blobsDir, entry.name))
    }
    return removed
  }
}
