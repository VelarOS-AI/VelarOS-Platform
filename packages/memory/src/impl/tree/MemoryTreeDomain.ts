/**
 * 记忆树 v1 的门面：`MemoryTreeDomain`。接口 `MemoryTreeDomainApi` 在本文件的类上方。
 * 它只做转接与编排：落库与查询交给 `MemoryTreeRepository`，整理与投影交给 `MemoryDream`。
 */

import { isEmpty } from '@velaros-ai/core'

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
} from '../../types/memory'
import { sanitizeMemoryEvidenceInput } from '../../utils/evidence'

import { MemoryDream } from './MemoryDream'
import { MemoryTreeRecall } from './MemoryTreeRecall'
import { type MemoryTreeRepository } from './MemoryTreeRepository'

/**
 * 记忆树 v1 的唯一门面：外面只经它读写这棵树，仓与整理器都不直接露出去。
 *
 * 实现是 `MemoryTreeDomain`，一个宿主一份，经 `createMemoryRuntime` 取得。
 * 所有写入先成为 Evidence；Concept/Episode/Claim/Relation 与树投影只由 Dream 生成——
 * 渲染进程、工具和宿主事件都不能绕过这条路径直接改意义对象。
 */
export interface MemoryTreeDomainApi {
  /** 落一条证据，默认顺手触发一次即时整理；`consolidate` 传 false 就只入库不整理。 */
  captureEvidence(input: MemoryEvidenceInput, consolidate?: boolean): MemoryCaptureResult
  /** 同一批证据原子落库，至少插进去一条时默认触发一次即时整理；回执带插入条数与当前树版本。 */
  captureEvidenceBatch(
    inputs: readonly MemoryEvidenceInput[],
    consolidate?: boolean
  ): MemoryCaptureBatchResult
  /** 显式跑一次整理（即时、启动续跑或空闲维护），返回这次整理的账本。 */
  runDream(options: MemoryDreamRunOptions): MemoryDreamRunResult
  /** 按查询词与作用域召回；查询为空时按作用域或时间给最近的几条，`deep` 打开深层回忆。 */
  recall(query: string, options?: MemoryRecallOptions): MemoryRecallItem[]
  /** 按主张 id 取一条召回结果；主张不存在时给 null。 */
  getClaim(claimId: string): Nullable<MemoryRecallItem>
  /** 取当前树状态：最新快照加当前全部节点。 */
  getTreeState(): MemoryTreeState
  /** 从 diff 链回放出某一版的树状态。版本不存在抛 NOT_FOUND，diff 链断了抛 INTERNAL。 */
  getTreeStateAtVersion(version: number): MemoryTreeState
  /** 从头核对整条 diff 链与每一版的哈希；不抛错，问题都写在回执的 errors 里。 */
  verifyTreeIntegrity(): MemoryTreeIntegrityReport
  /** 各表条数、两个前沿、树版本与卡住的整理数，给诊断页与后端回执用。 */
  getDiagnostics(): MemoryTreeDiagnostics
  /** 自然遗忘一条主张：转 dormant 并退出普通召回，证据仍保留供深层回忆；随后重投影。 */
  forgetClaim(claimId: string): MemoryForgetResult
  /** 改一条证据的可用状态：不抹除证据，向上回算支撑后重投影；证据不存在抛 NOT_FOUND。 */
  setEvidenceEligibility(
    evidenceId: string,
    state: MemoryEvidenceEligibilityState
  ): MemoryEvidenceEligibilityResult
  /** 按会话整体改证据可用状态：一条都没命中时只回当前树版本，不做多余投影。 */
  setSessionEvidenceEligibility(
    sessionId: string,
    state: MemoryEvidenceEligibilityState
  ): MemorySourceEligibilityResult
  /** 启动时调一次：先把崩溃遗留的整理账本收掉，再续跑尚未整理的证据；没有新输入时零写入。 */
  warmup(): MemoryDreamRunResult
  /** 把崩溃时停在 queued/running 的整理账本改判为可重试的 failed，返回改了几行。 */
  recoverOrphanDreamRuns(): number
}

export class MemoryTreeDomain implements MemoryTreeDomainApi {
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
