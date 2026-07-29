import { isEmpty } from '@velaros-ai/core'

import { MemoryDream } from './Dream'
import { MemoryTreeRecall } from './Recall'
import { type MemoryTreeRepository } from './Repository'
import { sanitizeMemoryEvidenceInput } from './Sanitizer'
import type {
  MemoryCaptureBatchResult,
  MemoryCaptureResult,
  MemoryDreamRunOptions,
  MemoryDreamRunResult,
  MemoryEvidenceEligibilityResult,
  MemoryEvidenceEligibilityState,
  MemoryEvidenceInput,
  MemoryForgetResult,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemorySourceEligibilityResult,
  MemoryTreeDiagnostics,
  MemoryTreeIntegrityReport,
  MemoryTreeState,
} from './Types'

/**
 * 新记忆内核的唯一门面。
 *
 * 所有写入先成为 Evidence；Concept/Episode/Claim/Relation 与树投影只由 Dream 生成。
 * Renderer、工具和宿主事件都不能绕过这条路径直接改意义对象。
 */
export class MemoryTreeDomain {
  private readonly dream: MemoryDream
  private readonly recallService: MemoryTreeRecall

  constructor(private readonly repository: MemoryTreeRepository) {
    this.dream = new MemoryDream(repository)
    this.recallService = new MemoryTreeRecall(repository)
  }

  public captureEvidence(input: MemoryEvidenceInput, consolidate: boolean = true): MemoryCaptureResult {
    const result = this.repository.captureEvidence(sanitizeMemoryEvidenceInput(input))
    if (result.inserted && consolidate) this.dream.run({ trigger: 'immediate' })
    return result
  }

  public captureEvidenceBatch(
    inputs: readonly MemoryEvidenceInput[],
    consolidate: boolean = true
  ): MemoryCaptureBatchResult {
    const results = this.repository.captureEvidenceBatch(
      inputs.map((input) => sanitizeMemoryEvidenceInput(input))
    )
    const insertedCount = results.filter((result) => result.inserted).length
    if (insertedCount > 0 && consolidate) this.dream.run({ trigger: 'immediate' })
    return {
      evidence: results.map((result) => result.evidence),
      insertedCount,
      treeVersion: this.repository.getMetaInteger('tree_version'),
    }
  }

  public runDream(options: MemoryDreamRunOptions): MemoryDreamRunResult {
    return this.dream.run(options)
  }

  public recall(query: string, options: MemoryRecallOptions = {}): MemoryRecallItem[] {
    return this.recallService.recall(query, options)
  }

  public getClaim(claimId: string): Nullable<MemoryRecallItem> {
    return this.repository.getRecallItem(claimId)
  }

  public getTreeState(): MemoryTreeState {
    return this.repository.getTreeState()
  }

  public getTreeStateAtVersion(version: number): MemoryTreeState {
    return this.repository.getTreeStateAtVersion(version)
  }

  public verifyTreeIntegrity(): MemoryTreeIntegrityReport {
    return this.repository.verifyTreeIntegrity()
  }

  public getDiagnostics(): MemoryTreeDiagnostics {
    return this.repository.getDiagnostics()
  }

  /** 自然遗忘：Claim 进入 dormant 并退出普通召回，Evidence 仍保留供深层回忆。 */
  public forgetClaim(claimId: string): MemoryForgetResult {
    const affectedEvidenceIds = this.repository.transaction(() =>
      this.repository.markClaimDormant(claimId)
    )
    const treeVersion = this.dream.reproject()
    return { claimId, affectedEvidenceIds, treeVersion }
  }

  /** 来源删除/排除不抹除 Evidence；支持度向上回算后重新投影。 */
  public setEvidenceEligibility(
    evidenceId: string,
    state: MemoryEvidenceEligibilityState
  ): MemoryEvidenceEligibilityResult {
    const affectedClaimIds = this.repository.transaction(() =>
      this.repository.setEvidenceEligibility(evidenceId, state)
    )
    const resumed = state === 'active' ? this.dream.run({ trigger: 'immediate' }) : null
    const treeVersion = resumed?.state === 'committed'
      ? resumed.treeVersionAfter
      : this.dream.reproject()
    return { evidenceId, state, affectedClaimIds, treeVersion }
  }

  public setSessionEvidenceEligibility(
    sessionId: string,
    state: MemoryEvidenceEligibilityState
  ): MemorySourceEligibilityResult {
    const affected = this.repository.transaction(() =>
      this.repository.setSessionEvidenceEligibility(sessionId, state)
    )
    const resumed = state === 'active' && !isEmpty(affected.evidenceIds)
      ? this.dream.run({ trigger: 'immediate' })
      : null
    const treeVersion = isEmpty(affected.evidenceIds)
      ? this.repository.getMetaInteger('tree_version')
      : resumed?.state === 'committed'
        ? resumed.treeVersionAfter
        : this.dream.reproject()
    return {
      sourceScope: 'session',
      sourceId: sessionId,
      state,
      affectedEvidenceIds: affected.evidenceIds,
      affectedClaimIds: affected.claimIds,
      treeVersion,
    }
  }

  /** 启动只续跑尚未整理的 Evidence；没有新输入时是零写入。 */
  public warmup(): MemoryDreamRunResult {
    this.recoverOrphanDreamRuns()
    return this.dream.run({ trigger: 'startup' })
  }

  public recoverOrphanDreamRuns(): number {
    return this.repository.recoverOrphanDreamRuns()
  }
}
