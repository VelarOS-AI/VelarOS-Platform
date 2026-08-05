/**
 * 把既有记忆树领域服务包成一个 `MemoryStoreBackend`。
 *
 * 这是「行为零变化」的载体：每个动词都**逐字转发**到 `MemoryTreeDomain` 的同名调用，
 * 参数与副作用一律不改写。批一之后既有记忆链路仍旧跑在这个后端上，只是路径从
 * 「适配器直连 domain」变成「适配器经 capability token 解析到本后端」。
 *
 * 定位（§九 9.1）：`memory-tree` 是**未来档**（加密树后端，WS3 资产的归宿）。它今天仍是
 * 已接线的权威层，`role` 因此标 `authority`；批三把权威迁到 `memory-files` 之后，这里改标
 * 未来档并只在装了树 mod 时出现。
 */

import type { MemoryTreeDomain } from '../memory-tree'

import type {
  MemoryBackendDescriptor,
  MemoryBackendStats,
  MemoryStoreBackend,
} from './Contract'

/**
 * 树后端实际消费的领域方法集合。
 *
 * 刻意用 `Pick` 而不是整个 `MemoryTreeDomain`：窄端口只应该够着自己要转发的动词，
 * warmup / 树版本 / 完整性校验属于树档自己的治理面，仍由 `MemoryService` 直接持有。
 */
export type MemoryTreeStoreDomain = Pick<
  MemoryTreeDomain,
  | 'captureEvidence'
  | 'captureEvidenceBatch'
  | 'recall'
  | 'getClaim'
  | 'getDiagnostics'
  | 'forgetClaim'
  | 'runDream'
  | 'setEvidenceEligibility'
  | 'setSessionEvidenceEligibility'
>

export const MemoryTreeBackendId = 'tree'

const treeDescriptor: MemoryBackendDescriptor = Object.freeze({
  id: MemoryTreeBackendId,
  role: 'authority',
  displayName: 'Memory tree (SQLite Evidence/Dream authority)',
  verbs: Object.freeze([
    'capture',
    'recall',
    'inspect',
    'archive',
    'dream',
    'govern',
  ] as const),
})

class MemoryTreeStoreBackend implements MemoryStoreBackend {
  public readonly descriptor = treeDescriptor

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
      backendId: MemoryTreeBackendId,
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
