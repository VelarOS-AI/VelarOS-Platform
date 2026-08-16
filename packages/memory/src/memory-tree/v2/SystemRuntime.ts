import {
  type MemoryAuthorityOpenReportV2,
  openMemoryAuthorityV2,
} from './AuthorityDatabase'
import { MemoryDreamRunCoordinatorV2 } from './DreamRuns'
import { MemoryErasureServiceV2 } from './ErasureSaga'
import { MemoryEvidenceIngestServiceV2 } from './EvidenceIngest'
import { MemoryEvidenceReplayMigrationV2 } from './EvidenceReplayMigration'
import { MemoryIdentityKeyServiceV2 } from './IdentityKeys'
import { MemoryMeaningCurationServiceV2 } from './MeaningCuration'
import { MemoryQueryFacadeV2 } from './QueryFacade'
import type { MemoryWrappingRootV2 } from './storage'
import {
  ContentKeyServiceV2,
  MemoryBlobStoreV2,
  MemoryKeyringStoreV2,
} from './storage'
import {
  type MemoryTreeStoreOpenReportV2,
  MemoryTreeStoreV2,
} from './TreeStore'

export interface OpenMemorySystemRuntimeOptionsV2 {
  readonly dataRoot: string
  readonly wrappingRoot: MemoryWrappingRootV2
  readonly now?: () => number
}

export interface MemorySystemRuntimeOpenReportV2 {
  readonly authority: MemoryAuthorityOpenReportV2
  readonly tree: MemoryTreeStoreOpenReportV2
  readonly recoveredOrphanBlobCount: number
  readonly resumedErasureCount: number
}

/**
 * Memory v2 的包内组合根。
 *
 * 宿主只注入数据根与操作系统包装根；SQLite、密钥环、密文块、证据、梦境整理、
 * 意义整理、擦除、重灌与查询的所有权都留在 memory 包内。此组合根不包含
 * 产品宿主的权威切换或旧表删除动词。
 */
export class MemorySystemRuntimeV2 {
  public readonly ingest: MemoryEvidenceIngestServiceV2
  public readonly dream: MemoryDreamRunCoordinatorV2
  public readonly meaning: MemoryMeaningCurationServiceV2
  public readonly erasure: MemoryErasureServiceV2
  public readonly replay: MemoryEvidenceReplayMigrationV2
  public readonly query: MemoryQueryFacadeV2

  private constructor(
    private readonly authority: ReturnType<
      typeof openMemoryAuthorityV2
    >['store'],
    services: {
      ingest: MemoryEvidenceIngestServiceV2
      dream: MemoryDreamRunCoordinatorV2
      meaning: MemoryMeaningCurationServiceV2
      erasure: MemoryErasureServiceV2
      replay: MemoryEvidenceReplayMigrationV2
      query: MemoryQueryFacadeV2
    }
  ) {
    this.ingest = services.ingest
    this.dream = services.dream
    this.meaning = services.meaning
    this.erasure = services.erasure
    this.replay = services.replay
    this.query = services.query
  }

  public static open(
    options: OpenMemorySystemRuntimeOptionsV2
  ): {
    runtime: MemorySystemRuntimeV2
    report: MemorySystemRuntimeOpenReportV2
  } {
    const authorityOpen = openMemoryAuthorityV2(options.dataRoot, {
      now: options.now,
    })
    try {
      const authority = authorityOpen.store
      const keyring = MemoryKeyringStoreV2.open(
        authority.roots.keyringDir,
        options.wrappingRoot,
        { now: options.now }
      ).store
      const blobs = new MemoryBlobStoreV2(authority.roots.blobsDir)
      const contentKeys = new ContentKeyServiceV2(keyring, blobs)
      const identityKeys = new MemoryIdentityKeyServiceV2(keyring)
      const ingest = new MemoryEvidenceIngestServiceV2(
        authority,
        contentKeys,
        identityKeys,
        blobs
      )
      const recoveredOrphanBlobCount = ingest.recoverOrphanedBlobs()
      const treeOpen = MemoryTreeStoreV2.open({
        authority,
        contentKeys,
        keyring,
      })
      const dream = new MemoryDreamRunCoordinatorV2(
        authority,
        contentKeys,
        treeOpen.store
      )
      const meaning = new MemoryMeaningCurationServiceV2(
        authority,
        contentKeys,
        identityKeys,
        treeOpen.store,
        dream
      )
      const erasure = new MemoryErasureServiceV2(
        authority,
        contentKeys,
        keyring,
        treeOpen.store
      )
      const resumedErasureCount = erasure.resumePending(
        options.now?.() ?? Date.now()
      ).length
      const replay = new MemoryEvidenceReplayMigrationV2(
        authority,
        ingest,
        contentKeys,
        identityKeys
      )
      const query = new MemoryQueryFacadeV2(
        authority,
        contentKeys,
        treeOpen.store
      )
      return {
        runtime: new MemorySystemRuntimeV2(authority, {
          ingest,
          dream,
          meaning,
          erasure,
          replay,
          query,
        }),
        report: {
          authority: authorityOpen.report,
          tree: treeOpen.report,
          recoveredOrphanBlobCount,
          resumedErasureCount,
        },
      }
    } catch (error) {
      authorityOpen.store.close()
      throw error
    }
  }

  public close(): void {
    this.query.clearSearchIndex()
    this.authority.close()
  }
}

export function openMemorySystemRuntimeV2(
  options: OpenMemorySystemRuntimeOptionsV2
): {
  runtime: MemorySystemRuntimeV2
  report: MemorySystemRuntimeOpenReportV2
} {
  return MemorySystemRuntimeV2.open(options)
}
