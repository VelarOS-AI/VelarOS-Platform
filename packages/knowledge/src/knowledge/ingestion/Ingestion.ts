import { createHash } from 'node:crypto'

import { isBlank, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { KnowledgeIndexStatuses } from '../../Constants'
import type { KnowledgeMutation } from '../domain/Mutation'
import type {
  KnowledgeIndexRuntime,
  KnowledgeRecord,
  KnowledgeSearchOptions,
  KnowledgeWorkspaceSyncOptions,
  KnowledgeWorkspaceSyncResult,
} from '../domain/Types'
import type { KnowledgeRepo } from '../storage'
import type { KnowledgeFileIndexRecord } from '../storage'

import type {
  KnowledgeWorkspace,
  KnowledgeWorkspaceCodeCandidate,
  KnowledgeWorkspacePreparedDocument,
} from './WorkspaceStore'

const WORKSPACE_SYNC_TTL_MS = 30_000
const log = logRuntime.tag('KnowledgeIngestion')

/** 代码候选同步结果，额外返回本次可参与搜索的候选文档 id。 */
interface KnowledgeCodeSyncResult {
  workspaceRoot: string
  candidateIds: string[]
  scanned: number
  upserted: number
  reindexed: number
  reindexBlocked: number
  removed: number
  skipped: number
}

/** 单个文件同步后的结果分类。 */
type KnowledgeSyncOutcome = 'upserted' | 'reindexed' | 'reindex-blocked' | 'skipped'

/**
 * 知识摄取服务。
 *
 * 负责扫描工作区文档和代码候选，比较文件快照，必要时调用 MutationService 写入/重建索引，
 * 并清理已经不存在或不再可索引的知识文档。
 */
export class KnowledgeIngestion {
  /** 工作区最近同步时间，用 TTL 避免每次搜索都全量扫描文档。 */
  private readonly lastSyncByWorkspace = new Map<string, number>()

  constructor(
    private readonly repository: KnowledgeRepo,
    private readonly workspaceStore: KnowledgeWorkspace,
    private readonly mutationService: KnowledgeMutation
  ) {}

  /** 带 TTL 的工作区文档同步入口。 */
  public async ensureWorkspaceSynced(
    workspaceRoot: string,
    options: KnowledgeWorkspaceSyncOptions = {}
  ): Promise<KnowledgeWorkspaceSyncResult> {
    const lastSyncAt = this.lastSyncByWorkspace.get(workspaceRoot) ?? 0
    if (!options.force && Date.now() - lastSyncAt < WORKSPACE_SYNC_TTL_MS) {
      // 短时间内已经同步过时直接返回空变更结果，减少搜索前 I/O。
      return {
        workspaceRoot,
        scanned: 0,
        upserted: 0,
        reindexed: 0,
        reindexBlocked: 0,
        removed: 0,
        skipped: 0,
        forced: false,
      }
    }

    return this.syncWorkspace(workspaceRoot, options)
  }

  /** 扫描并同步 markdown/text/json/config 等文档类知识。 */
  public async syncWorkspace(
    workspaceRoot: string,
    options: KnowledgeWorkspaceSyncOptions = {}
  ): Promise<KnowledgeWorkspaceSyncResult> {
    if (isBlank(workspaceRoot)) {
      throw new AppError('VALIDATION', '同步知识文档时必须提供 workspaceRoot')
    }

    const startedAt = Date.now()
    log.info('knowledge workspace sync start', {
      forced: !!options.force,
    })
    const currentRuntime = this.mutationService.getCurrentIndexRuntime()
    // scannedFiles 是当前文件系统视图；existing/snapshots 是数据库视图，后面做差异对比。
    const scannedFiles = await this.workspaceStore.listDocumentFiles(workspaceRoot)
    const existingDocuments = this.repository.listKnowledgeByWorkspaceRoot(workspaceRoot, [
      'markdown',
      'text',
      'json',
      'config',
    ])
    const existingByPath = new Map(existingDocuments.map((document) => [document.path, document]))
    const snapshotsByPath = new Map(
      this.repository
        .listFileIndexByWorkspaceRoot(workspaceRoot, ['markdown', 'text', 'json', 'config'])
        .map((snapshot) => [snapshot.path, snapshot])
    )
    const activePaths = new Set<string>()

    let upserted = 0
    let reindexed = 0
    let reindexBlocked = 0
    let skipped = 0

    for (const file of scannedFiles) {
      // 通过 path 对齐文件系统、知识文档和文件快照。
      const existing = toNullable(existingByPath.get(file.path))
      const snapshot = toNullable(snapshotsByPath.get(file.path))

      try {
        const outcome = await this.syncDocumentFile(file, existing, snapshot, currentRuntime)
        if (!outcome) {
          continue
        }

        activePaths.add(file.path)
        if (outcome === 'upserted') {
          upserted += 1
          continue
        }
        if (outcome === 'reindexed') {
          reindexed += 1
          continue
        }
        if (outcome === 'reindex-blocked') {
          reindexBlocked += 1
          continue
        }
        skipped += 1
      } catch (error) {
        skipped += 1
        log.warn('knowledge document sync failed', {
          code: AppError.from(error).code,
        })
      }
    }

    let removed = 0
    for (const existing of existingDocuments) {
      if (activePaths.has(existing.path)) {
        continue
      }

      try {
        // 扫描不到的旧文档说明已删除或不再可见，知识库也同步清理。
        await this.mutationService.deleteKnowledge(existing.id)
        removed += 1
      } catch (error) {
        log.warn('knowledge document delete failed', {
          code: AppError.from(error).code,
        })
      }
    }

    this.lastSyncByWorkspace.set(workspaceRoot, Date.now())
    const result = {
      workspaceRoot,
      scanned: scannedFiles.length,
      upserted,
      reindexed,
      reindexBlocked,
      removed,
      skipped,
      forced:!!options.force,
    }
    log.info('knowledge workspace sync end', {
      scanned: result.scanned,
      upserted: result.upserted,
      reindexBlocked: result.reindexBlocked,
      removed: result.removed,
      skipped: result.skipped,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  /** 同步本次搜索相关的代码候选文件。 */
  public async syncCodeCandidates(
    workspaceRoot: string,
    options: Pick<KnowledgeSearchOptions, 'pathHints' | 'symbolHints' | 'documentIds'>
  ): Promise<KnowledgeCodeSyncResult> {
    if (isBlank(workspaceRoot)) {
      throw new AppError('VALIDATION', '同步代码知识时必须提供 workspaceRoot')
    }

    const startedAt = Date.now()
    log.info('knowledge code candidate sync start')
    const currentRuntime = this.mutationService.getCurrentIndexRuntime()
    // 代码候选不是全量同步，而是根据 path/symbol hint 选出少量最相关文件。
    const candidateDocuments = await this.workspaceStore.listCodeCandidates({
      workspaceRoot,
      pathHints: options.pathHints ?? [],
      symbolHints: options.symbolHints ?? [],
    })
    const explicitIds = new Set(options.documentIds ?? [])
    const existingCodeDocuments = this.repository.listKnowledgeByWorkspaceRoot(workspaceRoot, [
      'code',
    ])
    const existingByPath = new Map(
      existingCodeDocuments.map((document) => [document.path, document])
    )
    const snapshotsByPath = new Map(
      this.repository
        .listFileIndexByWorkspaceRoot(workspaceRoot, ['code'])
        .map((snapshot) => [snapshot.path, snapshot])
    )
    const candidateIds: string[] = []
    const activePaths = new Set<string>()
    let upserted = 0
    let reindexed = 0
    let reindexBlocked = 0
    let skipped = 0

    for (const candidate of candidateDocuments) {
      const existing = toNullable(existingByPath.get(candidate.document.path))
      const snapshot = toNullable(snapshotsByPath.get(candidate.document.path))

      try {
        const synced = await this.syncPreparedDocument(
          candidate,
          existing,
          snapshot,
          currentRuntime
        )
        activePaths.add(candidate.document.path)
        candidateIds.push(synced.knowledgeId)

        if (synced.outcome === 'upserted') {
          upserted += 1
          continue
        }
        if (synced.outcome === 'reindexed') {
          reindexed += 1
          continue
        }
        if (synced.outcome === 'reindex-blocked') {
          reindexBlocked += 1
          continue
        }
        skipped += 1
      } catch (error) {
        skipped += 1
        log.warn('knowledge code candidate sync failed', {
          code: AppError.from(error).code,
        })
      }
    }

    const removed = await this.cleanupStaleCodeKnowledge(
      workspaceRoot,
      existingCodeDocuments,
      activePaths
    )

    const result = {
      workspaceRoot,
      candidateIds: explicitIds.size
        ? // 调用方显式限定 documentIds 时，再对本轮候选做交集。
          candidateIds.filter((id) => explicitIds.has(id))
        : candidateIds,
      scanned: candidateDocuments.length,
      upserted,
      reindexed,
      reindexBlocked,
      removed,
      skipped,
    }
    log.info('knowledge code candidate sync end', {
      scanned: result.scanned,
      upserted: result.upserted,
      reindexBlocked: result.reindexBlocked,
      removed: result.removed,
      skipped: result.skipped,
      durationMs: Date.now() - startedAt,
    })
    return result
  }

  /** 同步单个普通文档文件。 */
  private async syncDocumentFile(
    file: Parameters<KnowledgeWorkspace['prepareDocument']>[0],
    existing: Nullable<KnowledgeRecord>,
    snapshot: Nullable<KnowledgeFileIndexRecord>,
    runtime: KnowledgeIndexRuntime
  ): Promise<Nullable<KnowledgeSyncOutcome>> {
    if (existing && snapshot && this.matchesSnapshot(file, snapshot, existing.sourceKind)) {
      if (this.needsReindex(existing, snapshot, runtime)) {
        // 自动同步禁止重建既有索引；只能在记忆管理里手动触发重建。
        return 'reindex-blocked'
      }

      this.upsertSnapshot(existing.id, file, snapshot.contentHash, runtime, snapshot)
      return 'skipped'
    }

    // 文件快照变化后需要重新读取内容，空文件/二进制文件会跳过索引。
    const prepared = await this.workspaceStore.prepareDocument(file)
    if (!prepared) return null

    const synced = await this.syncPreparedDocument(prepared, existing, snapshot, runtime)
    return synced.outcome
  }

  /** 同步已经准备好的文档或代码候选。 */
  private async syncPreparedDocument(
    prepared: KnowledgeWorkspacePreparedDocument | KnowledgeWorkspaceCodeCandidate,
    existing: Nullable<KnowledgeRecord>,
    snapshot: Nullable<KnowledgeFileIndexRecord>,
    runtime: KnowledgeIndexRuntime
  ): Promise<{ knowledgeId: string; outcome: KnowledgeSyncOutcome }> {
    const normalizedContentHash = prepared.contentHash

    if (
      existing &&
      existing.sourceKind === prepared.document.sourceKind &&
      this.buildNormalizedContentHash(existing.content) === normalizedContentHash
    ) {
      if (this.needsReindex(existing, snapshot, runtime)) {
        // 自动同步禁止重建既有索引；保留旧索引并等待记忆管理手动修复。
        return {
          knowledgeId: existing.id,
          outcome: 'reindex-blocked',
        }
      }

      this.upsertSnapshot(existing.id, prepared.file, normalizedContentHash, runtime, snapshot)
      return {
        knowledgeId: existing.id,
        outcome: 'skipped',
      }
    }

    // 新文件或内容变化时写入知识文档，MutationService 会负责分块和向量同步。
    const saved = await this.mutationService.upsertKnowledge(prepared.document)
    this.upsertSnapshot(saved.id, prepared.file, normalizedContentHash, runtime, snapshot)
    return {
      knowledgeId: saved.id,
      outcome: 'upserted',
    }
  }

  /** 清理不在本次候选里且文件已消失/不可索引的代码知识。 */
  private async cleanupStaleCodeKnowledge(
    workspaceRoot: string,
    existingDocuments: KnowledgeRecord[],
    activePaths: Set<string>
  ): Promise<number> {
    let removed = 0

    for (const existing of existingDocuments) {
      if (activePaths.has(existing.path)) {
        continue
      }

      try {
        const inspection = await this.workspaceStore.inspectIndexedFile(
          workspaceRoot,
          existing.path,
          existing.sourceKind
        )
        if (inspection.exists && inspection.indexable) {
          // 文件仍然存在且可索引，只是本轮不相关，不能删除。
          continue
        }

        await this.mutationService.deleteKnowledge(existing.id)
        removed += 1
      } catch (error) {
        log.warn('knowledge stale code cleanup failed', {
          code: AppError.from(error).code,
        })
      }
    }

    return removed
  }

  /** 判断文件系统元信息是否与上次快照一致。 */
  private matchesSnapshot(
    file: Parameters<KnowledgeWorkspace['prepareDocument']>[0],
    snapshot: KnowledgeFileIndexRecord,
    sourceKind: KnowledgeRecord['sourceKind']
  ): boolean {
    return (
      snapshot.sourceKind === sourceKind &&
      snapshot.sourceKind === file.sourceKind &&
      snapshot.fileSize === file.fileSize &&
      snapshot.modifiedAt === file.modifiedAt
    )
  }

  /** 判断内容/分块快照是否损坏；embedding profile 切换不属于重建条件。 */
  private needsReindex(
    existing: KnowledgeRecord,
    snapshot: Nullable<KnowledgeFileIndexRecord>,
    runtime: KnowledgeIndexRuntime
  ): boolean {
    return (
      existing.indexStatus !== KnowledgeIndexStatuses.READY ||
      existing.chunkCount <= 0 ||
      isBlank(existing.indexTextHash) ||
      (!!snapshot && snapshot.indexRuntimeKey !== runtime.indexRuntimeKey)
    )
  }

  /** 写入或刷新文件索引快照。 */
  private upsertSnapshot(
    knowledgeId: string,
    file: KnowledgeWorkspacePreparedDocument['file'],
    contentHash: string,
    runtime: KnowledgeIndexRuntime,
    snapshot: Nullable<KnowledgeFileIndexRecord>
  ): void {
    const now = Date.now()
    this.repository.upsertFileIndex({
      knowledgeId,
      workspaceRoot: file.workspaceRoot,
      path: file.path,
      sourceKind: file.sourceKind,
      fileSize: file.fileSize,
      modifiedAt: file.modifiedAt,
      contentHash,
      indexRuntimeKey: runtime.indexRuntimeKey,
      createdAt: snapshot?.createdAt ?? now,
      updatedAt: now,
      lastSeenAt: now,
    })
  }

  /** 用规范化内容 hash 对比，避免结尾空白导致误判内容变化。 */
  private buildNormalizedContentHash(content: string): string {
    return createHash('sha1').update(content.trim()).digest('hex')
  }
}

export type { KnowledgeCodeSyncResult }
