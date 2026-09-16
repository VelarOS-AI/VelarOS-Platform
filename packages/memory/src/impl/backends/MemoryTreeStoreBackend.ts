/**
 * 把既有记忆树领域服务包成一个 `MemoryStoreBackend`。
 *
 * 每个动词都转发到 `MemoryTreeDomain` 的同名调用，参数与副作用不改写。适配器通过
 * capability token 解析本后端，而不是直接依赖具体存储实现。
 *
 * `memory-tree` 当前仍是默认权威层，因此 descriptor 的 `role` 为 `authority`。任何默认权威
 * 迁移都必须先完成数据迁移和宿主切换，再调整这里的注册角色。
 */

import { MemoryBackendIds } from '../../contract/constants'
import type { MemoryStoreBackend, MemoryTreeStoreDomain } from '../../contract/requires'
import type { MemoryBackendDescriptor, MemoryBackendStats } from '../../types/memory'

/** 把记忆树领域服务包成窄端口后端；实例由 `createMemoryTreeStoreBackend` 造，不持额外状态。 */
export class MemoryTreeStoreBackend implements MemoryStoreBackend {
  /** 树后端的自述：六个动词全有（树档自带整理管线与证据可用性状态机）。 */
  private static readonly Descriptor: MemoryBackendDescriptor = Object.freeze({
    id: MemoryBackendIds.tree,
    role: 'authority',
    displayName: '记忆树（SQLite 证据/整理权威层）',
    verbs: Object.freeze([
      'capture',
      'recall',
      'inspect',
      'archive',
      'dream',
      'govern',
    ] as const),
  })

  public readonly descriptor = MemoryTreeStoreBackend.Descriptor

  public constructor(private readonly domain: MemoryTreeStoreDomain) {}

  public capture(
    ...arguments_: Parameters<MemoryStoreBackend['capture']>
  ): ReturnType<MemoryTreeStoreDomain['captureEvidence']> {
    return this.domain.captureEvidence(arguments_[0])
  }

  public captureBatch(
    inputs: Parameters<MemoryStoreBackend['captureBatch']>[0],
    options?: Parameters<MemoryStoreBackend['captureBatch']>[1],
  ): ReturnType<MemoryTreeStoreDomain['captureEvidenceBatch']> {
    // 既有调用点传 `consolidate=false`（EvidenceBridge 自己控制 Dream 触发时机）；
    // 缺省保持 domain 的 `true`，与直连时逐字一致。
    return this.domain.captureEvidenceBatch(inputs, options?.consolidate ?? true)
  }

  public recall(
    query: string,
    options?: Parameters<MemoryStoreBackend['recall']>[1],
  ): ReturnType<MemoryTreeStoreDomain['recall']> {
    return this.domain.recall(query, options)
  }

  public getItem(id: string): ReturnType<MemoryTreeStoreDomain['getClaim']> {
    return this.domain.getClaim(id)
  }

  public inspect(): MemoryBackendStats {
    const diagnostics = this.domain.getDiagnostics()
    return {
      backendId: MemoryBackendIds.tree,
      itemCount: diagnostics.claimCount,
      pendingCount: diagnostics.pendingEvidenceCount,
      version: diagnostics.treeVersion,
      details: {
        evidenceCount: diagnostics.evidenceCount,
        conceptCount: diagnostics.conceptCount,
        episodeCount: diagnostics.episodeCount,
        treeNodeCount: diagnostics.treeNodeCount,
        stalledDreamRunCount: diagnostics.stalledDreamRunCount,
      },
    }
  }

  public archive(id: string): ReturnType<MemoryTreeStoreDomain['forgetClaim']> {
    return this.domain.forgetClaim(id)
  }

  public dream(
    options: Parameters<MemoryTreeStoreDomain['runDream']>[0],
  ): ReturnType<MemoryTreeStoreDomain['runDream']> {
    return this.domain.runDream(options)
  }

  public governSourceEligibility(
    sourceId: string,
    state: Parameters<MemoryTreeStoreDomain['setSessionEvidenceEligibility']>[1],
  ): ReturnType<MemoryTreeStoreDomain['setSessionEvidenceEligibility']> {
    return this.domain.setSessionEvidenceEligibility(sourceId, state)
  }

  public governEvidenceEligibility(
    evidenceId: string,
    state: Parameters<MemoryTreeStoreDomain['setEvidenceEligibility']>[1],
  ): ReturnType<MemoryTreeStoreDomain['setEvidenceEligibility']> {
    return this.domain.setEvidenceEligibility(evidenceId, state)
  }
}

/** 把已打开的记忆树领域服务包成后端；不持有额外状态，可以随时重复构造。 */
export function createMemoryTreeStoreBackend(
  domain: MemoryTreeStoreDomain,
): MemoryStoreBackend {
  return new MemoryTreeStoreBackend(domain)
}
