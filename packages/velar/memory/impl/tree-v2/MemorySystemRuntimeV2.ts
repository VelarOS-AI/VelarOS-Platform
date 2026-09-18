import type {
  MemorySystemRuntimeOpenReportV2,
  OpenMemorySystemRuntimeOptionsV2,
} from '../../types/tree-v2/store.js'

import { ContentKeyServiceV2 } from './storage/ContentKeyServiceV2.js'
import { MemoryBlobStoreV2 } from './storage/MemoryBlobStoreV2.js'
import { MemoryKeyringStoreV2 } from './storage/MemoryKeyringStoreV2.js'
import { MemoryAuthorityDatabaseV2 } from './MemoryAuthorityDatabaseV2.js'
import type { MemoryDreamRunCoordinatorV2Api } from './MemoryDreamRunCoordinatorV2.js'
import { MemoryDreamRunCoordinatorV2 } from './MemoryDreamRunCoordinatorV2.js'
import type { MemoryErasureServiceV2Api } from './MemoryErasureServiceV2.js'
import { MemoryErasureServiceV2 } from './MemoryErasureServiceV2.js'
import type { MemoryEvidenceIngestServiceV2Api } from './MemoryEvidenceIngestServiceV2.js'
import { MemoryEvidenceIngestServiceV2 } from './MemoryEvidenceIngestServiceV2.js'
import type { MemoryEvidenceReplayMigrationV2Api } from './MemoryEvidenceReplayMigrationV2.js'
import { MemoryEvidenceReplayMigrationV2 } from './MemoryEvidenceReplayMigrationV2.js'
import { MemoryIdentityKeyServiceV2 } from './MemoryIdentityKeyServiceV2.js'
import type { MemoryMeaningCurationServiceV2Api } from './MemoryMeaningCurationServiceV2.js'
import { MemoryMeaningCurationServiceV2 } from './MemoryMeaningCurationServiceV2.js'
import type { MemoryQueryFacadeV2Api } from './MemoryQueryFacadeV2.js'
import { MemoryQueryFacadeV2 } from './MemoryQueryFacadeV2.js'
import { MemoryTreeStoreV2 } from './MemoryTreeStoreV2.js'

/**
 * 记忆 v2 的包内组合根：构造即打开数据根、装配全部服务并把半途崩溃的状态收敛回来。
 *
 * 宿主只注入数据根与操作系统包装根；SQLite、密钥环、密文块、证据、整理运行、意义整理、
 * 擦除、重灌与查询的所有权都留在本包内。这个组合根不含产品宿主的权威切换或旧表删除动词。
 * 实例归调用方所有，用完必须 `close()`。
 */
export interface MemorySystemRuntimeV2Api {
  /** 构造时那一次打开的读数：权威库、树存储、回收的孤儿 blob 数、续跑的擦除 saga 数。 */
  readonly openReport: MemorySystemRuntimeOpenReportV2
  /** 证据摄入服务。 */
  readonly ingest: MemoryEvidenceIngestServiceV2Api
  /** 整理运行的开启与提交协调者。 */
  readonly dream: MemoryDreamRunCoordinatorV2Api
  /** 意义候选的裁决与落库服务。 */
  readonly meaning: MemoryMeaningCurationServiceV2Api
  /** 彻底清除 saga。 */
  readonly erasure: MemoryErasureServiceV2Api
  /** 旧库证据回放与权威切换判定。 */
  readonly replay: MemoryEvidenceReplayMigrationV2Api
  /** 召回与树结构查询门面。 */
  readonly query: MemoryQueryFacadeV2Api
  /** 清掉查询缓存并关闭权威连接；重复调用是空操作。 */
  close(): void
}

export class MemorySystemRuntimeV2 implements MemorySystemRuntimeV2Api {
  public readonly openReport: MemorySystemRuntimeOpenReportV2
  public readonly ingest: MemoryEvidenceIngestServiceV2Api
  public readonly dream: MemoryDreamRunCoordinatorV2Api
  public readonly meaning: MemoryMeaningCurationServiceV2Api
  public readonly erasure: MemoryErasureServiceV2Api
  public readonly replay: MemoryEvidenceReplayMigrationV2Api
  public readonly query: MemoryQueryFacadeV2Api

  private readonly authority: MemoryAuthorityDatabaseV2

  constructor(options: OpenMemorySystemRuntimeOptionsV2) {
    const authority = new MemoryAuthorityDatabaseV2(options.dataRoot, { now: options.now })
    this.authority = authority
    try {
      const keyring = new MemoryKeyringStoreV2(
        authority.roots.keyringDir,
        options.wrappingRoot,
        { now: options.now }
      )
      const blobs = new MemoryBlobStoreV2(authority.roots.blobsDir)
      const contentKeys = new ContentKeyServiceV2(keyring, blobs)
      const identityKeys = new MemoryIdentityKeyServiceV2(keyring)
      const ingest = new MemoryEvidenceIngestServiceV2(authority, contentKeys, identityKeys, blobs)
      const recoveredOrphanBlobCount = ingest.recoverOrphanedBlobs()
      const tree = new MemoryTreeStoreV2(authority, contentKeys, keyring)
      const dream = new MemoryDreamRunCoordinatorV2(authority, contentKeys, tree)
      const meaning = new MemoryMeaningCurationServiceV2(
        authority,
        contentKeys,
        identityKeys,
        tree,
        dream
      )
      const erasure = new MemoryErasureServiceV2(authority, contentKeys, keyring, tree)
      const resumedErasureCount = erasure.resumePending(options.now?.() ?? Date.now()).length
      this.ingest = ingest
      this.dream = dream
      this.meaning = meaning
      this.erasure = erasure
      this.replay = new MemoryEvidenceReplayMigrationV2(
        authority,
        ingest,
        contentKeys,
        identityKeys
      )
      this.query = new MemoryQueryFacadeV2(authority, contentKeys, tree)
      this.openReport = {
        authority: authority.openReport,
        tree: tree.openReport,
        recoveredOrphanBlobCount,
        resumedErasureCount,
      }
    } catch (error) {
      authority.close()
      throw error
    }
  }

  public close(): void {
    this.query.clearSearchIndex()
    this.authority.close()
  }
}
