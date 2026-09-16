import { isBlank, isEmpty, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  KnowledgeCodeSyncResult,
  KnowledgeSyncOutcome,
  KnowledgeWorkspaceCodeCandidate,
  KnowledgeWorkspaceFileEntry,
  KnowledgeWorkspacePreparedDocument,
} from '../../types/ingestion.js'
import type {
  KnowledgeIndexRuntime,
  KnowledgeRecord,
  KnowledgeSearchOptions,
  KnowledgeWorkspaceSyncOptions,
  KnowledgeWorkspaceSyncResult,
  KnowledgeWorkspaceSyncState,
} from '../../types/knowledge.js'
import type { KnowledgeFileIndexRecord } from '../../types/storage.js'
import { buildNormalizedContentHash } from '../../utils/indexing.js'
import { KnowledgeTuning } from '../../utils/tuning.js'
import { matchesFileSnapshot, needsContentReindex } from '../../utils/workspace.js'
import type { KnowledgeRepositoryApi } from '../storage/KnowledgeRepository.js'

import type { KnowledgeMutationApi } from './KnowledgeMutation.js'
import type { KnowledgeWorkspaceApi } from './KnowledgeWorkspace.js'

const log = Log.tag('KnowledgeIngestion')

/**
 * 知识摄取服务：扫描工作区文档与代码候选、比对文件快照、必要时交给写入服务建索引，
 * 并清理已经不存在或不再可索引的旧文档。
 *
 * 同步态与短时 TTL 台账都在实例上；同一个工作区的并发同步会合并成一次。
 */
export interface KnowledgeIngestionApi {
  /** 各工作区本次运行的最近同步时刻；重启后为空是诚实回答，不是缺陷。 */
  listWorkspaceSyncStates(): KnowledgeWorkspaceSyncState[]
  /** 带 TTL 的工作区文档同步入口；TTL 内直接返回一份空变更结果。 */
  ensureWorkspaceSynced(
    workspaceRoot: string,
    options?: KnowledgeWorkspaceSyncOptions
  ): Promise<KnowledgeWorkspaceSyncResult>
  /** 不看 TTL 直接同步一次；同一个工作区的并发调用共享同一个 Promise。 */
  syncWorkspace(
    workspaceRoot: string,
    options?: KnowledgeWorkspaceSyncOptions
  ): Promise<KnowledgeWorkspaceSyncResult>
  /** 按路径与符号提示同步本次检索相关的代码候选。 */
  syncCodeCandidates(
    workspaceRoot: string,
    options: Pick<KnowledgeSearchOptions, 'pathHints' | 'symbolHints' | 'documentIds'>
  ): Promise<KnowledgeCodeSyncResult>
}

/** 见 {@link KnowledgeIngestionApi}。 */
export class KnowledgeIngestion implements KnowledgeIngestionApi {
  /** 各工作区最近一次同步的时刻，用 TTL 避免每次搜索都全量扫描。 */
  private readonly lastSyncByWorkspace = new Map<string, number>()
  private readonly workspaceSyncs = new Map<string, Promise<KnowledgeWorkspaceSyncResult>>()

  constructor(
    private readonly repository: Pick<
      KnowledgeRepositoryApi,
      'listKnowledgeByWorkspaceRoot' | 'listFileIndexByWorkspaceRoot' | 'upsertFileIndex'
    >,
    private readonly workspaceStore: Pick<
      KnowledgeWorkspaceApi,
      'listDocumentFiles' | 'prepareDocument' | 'listCodeCandidates' | 'inspectIndexedFile'
    >,
    private readonly mutationService: Pick<
      KnowledgeMutationApi,
      'getCurrentIndexRuntime' | 'upsertKnowledge' | 'deleteKnowledge'
    >
  ) {}

  public listWorkspaceSyncStates(): KnowledgeWorkspaceSyncState[] {
    return [...this.lastSyncByWorkspace].map(([workspaceRoot, lastSyncedAt]) => ({
      workspaceRoot,
      lastSyncedAt,
    }))
  }

  public async ensureWorkspaceSynced(
    workspaceRoot: string,
    options: KnowledgeWorkspaceSyncOptions = {}
  ): Promise<KnowledgeWorkspaceSyncResult> {
    const lastSyncAt = this.lastSyncByWorkspace.get(workspaceRoot) ?? 0
    if (!options.force && Date.now() - lastSyncAt < KnowledgeTuning.workspace.syncTtlMs) {
      // 短时间内已经同步过就直接返回空变更结果，减少搜索前的 I/O。
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

  public syncWorkspace(
    workspaceRoot: string,
    options: KnowledgeWorkspaceSyncOptions = {}
  ): Promise<KnowledgeWorkspaceSyncResult> {
    const existing = this.workspaceSyncs.get(workspaceRoot)
    if (existing) return existing
    const pending = this.syncWorkspaceNow(workspaceRoot, options)
    this.workspaceSyncs.set(workspaceRoot, pending)
    const finish = (): void => {
      this.workspaceSyncs.delete(workspaceRoot)
    }
    void pending.then(finish, finish)
    return pending
  }

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
    // 代码候选不是全量同步，而是按路径与符号提示挑出少量最相关的文件。
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
        ? // 调用方显式限定 documentIds 时，再对本轮候选做一次交集。
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

  /** 真正跑一次工作区文档同步：扫描、比对、写入、清理。 */
  private async syncWorkspaceNow(
    workspaceRoot: string,
    options: KnowledgeWorkspaceSyncOptions = {}
  ): Promise<KnowledgeWorkspaceSyncResult> {
    if (isBlank(workspaceRoot)) {
      throw new AppError('VALIDATION', '同步知识文档时必须提供 workspaceRoot')
    }

    // 强制同步一旦失败也应允许立刻重试，不能继续沿用上一次成功的短期缓存。
    this.lastSyncByWorkspace.delete(workspaceRoot)
    const startedAt = Date.now()
    log.info('knowledge workspace sync start', {
      forced: !!options.force,
    })
    const currentRuntime = this.mutationService.getCurrentIndexRuntime()
    // scannedFiles 是当前的文件系统视图；existing/snapshots 是数据库视图，下面做差异对比。
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
    const failures: unknown[] = []

    for (const file of scannedFiles) {
      // 用 path 对齐文件系统、知识文档与文件快照三边。
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
        failures.push(error)
        skipped += 1
        log.warn('knowledge document sync failed', {
          code: AppError.from(error).code,
        })
      }
    }

    if (!isEmpty(failures)) {
      throw new AppError(
        'UNAVAILABLE',
        '知识工作区同步不完整，已有索引继续保留，请稍后重试。',
        failures[0]
      )
    }

    let removed = 0
    for (const existing of existingDocuments) {
      if (activePaths.has(existing.path)) {
        continue
      }

      try {
        // 只有完整扫描与读取都成功之后，才能清理确认已删除或不再可索引的旧文档。
        await this.mutationService.deleteKnowledge(existing.id)
        removed += 1
      } catch (error) {
        log.warn('knowledge document delete failed', {
          code: AppError.from(error).code,
        })
        throw error
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
      forced: !!options.force,
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

  /** 同步单个普通文档文件。 */
  private async syncDocumentFile(
    file: KnowledgeWorkspaceFileEntry,
    existing: Nullable<KnowledgeRecord>,
    snapshot: Nullable<KnowledgeFileIndexRecord>,
    runtime: KnowledgeIndexRuntime
  ): Promise<Nullable<KnowledgeSyncOutcome>> {
    if (existing && snapshot && matchesFileSnapshot(file, snapshot, existing.sourceKind)) {
      if (needsContentReindex(existing, snapshot, runtime)) {
        // 自动同步不许重建既有索引；只能在记忆管理里手动触发重建。
        return 'reindex-blocked'
      }

      this.upsertSnapshot(existing.id, file, snapshot.contentHash, runtime, snapshot)
      return 'skipped'
    }

    // 文件快照变了就重新读内容；空文件与二进制文件会跳过索引。
    const prepared = await this.workspaceStore.prepareDocument(file)
    if (!prepared) return null

    const synced = await this.syncPreparedDocument(prepared, existing, snapshot, runtime)
    return synced.outcome
  }

  /** 同步一份已经准备好的文档或代码候选。 */
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
      buildNormalizedContentHash(existing.content) === normalizedContentHash
    ) {
      if (needsContentReindex(existing, snapshot, runtime)) {
        // 自动同步不许重建既有索引；保留旧索引，等记忆管理里手动修复。
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

    // 新文件或内容变了就写入知识文档，写入服务负责分块与向量同步。
    const saved = await this.mutationService.upsertKnowledge(prepared.document)
    this.upsertSnapshot(saved.id, prepared.file, normalizedContentHash, runtime, snapshot)
    return {
      knowledgeId: saved.id,
      outcome: 'upserted',
    }
  }

  /** 清理不在本轮候选里、且文件已消失或不再可索引的代码知识。 */
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
          // 文件还在、还能索引，只是本轮不相关，不能删。
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

  /** 写入或刷新一份文件索引快照。 */
  private upsertSnapshot(
    knowledgeId: string,
    file: KnowledgeWorkspaceFileEntry,
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
}
