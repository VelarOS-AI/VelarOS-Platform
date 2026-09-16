import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { HostIdleSignalPort } from '../../contract/requires'
import type {
  MemoryDreamRunOptions,
  MemoryDreamRunResult,
  MemoryEvidenceEligibilityResult,
  MemoryEvidenceEligibilityState,
  MemoryEvidenceInput,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryTreeDiagnostics,
  MemoryTreeIntegrityReport,
  MemoryTreeState,
} from '../../types/memory'
import type { MemoryTreeDomainApi as MemoryDomain } from '../tree/MemoryTreeDomain'

import { MemoryDreamScheduler } from './MemoryDreamScheduler'

/** 一个树治理门面要什么。 */
export interface MemoryServiceOptions {
  /** 空闲/电池/前台读数端口；后台整理调度器判定时机时消费。 */
  idleSignal: HostIdleSignalPort
  /** 自动记忆总开关；缺席按开。 */
  isAutoMemoryEnabled?: () => boolean
  /** 后台生长开关；缺席按开。 */
  isBackgroundGrowthEnabled?: () => boolean
  /** 电池供电时允不允许继续整理；缺席按不允许。 */
  allowBatteryGrowth?: () => boolean
}

/**
 * 记忆树的治理门面：任意宿主用它管树档的生命周期与治理操作。
 *
 * 实例由 `mountMemoryAdapter` 造，宿主经 `adapter.service` 拿到。它只管树档——没有树档的
 * 后端（文件档）根本不会有这个门面。
 */
export interface MemoryTreeServiceApi {
  /** 启动预热：补跑一次整理并起后台调度；失败只记诊断，不挡启动。 */
  warmup(): Promise<void>
  /** 写入一条证据。 */
  captureEvidence(input: MemoryEvidenceInput): ReturnType<MemoryDomain['captureEvidence']>
  /** 按查询召回。 */
  recall(query: string, options?: MemoryRecallOptions): MemoryRecallItem[]
  /** 跑一次整理（按给定触发源与批量）。 */
  runDream(options: MemoryDreamRunOptions): MemoryDreamRunResult
  /** 立刻跑一次整理（手动触发，不看空闲与电池门）。 */
  runDreamNow(abortSignal?: AbortSignal): MemoryDreamRunResult
  /** 读树的完整状态。 */
  getTreeState(): MemoryTreeState
  /** 读树在某个版本上的状态。 */
  getTreeStateAtVersion(version: number): MemoryTreeState
  /** 校验树的完整性。 */
  verifyTreeIntegrity(): MemoryTreeIntegrityReport
  /** 改单条证据的可用性。 */
  setEvidenceEligibility(
    evidenceId: string,
    state: MemoryEvidenceEligibilityState
  ): MemoryEvidenceEligibilityResult
  /** 读诊断读数。 */
  getDiagnostics(): MemoryTreeDiagnostics
  /** 收尾：停掉后台调度。SQLite 连接由宿主统一持有，这里没有独立资源要关。 */
  close(): void
}

/** 记忆树治理门面实现。 */
export class MemoryService implements MemoryTreeServiceApi {
  private readonly log = Log.tag('MemoryService')
  private readonly scheduler: MemoryDreamScheduler
  private readonly isGrowthEnabled: () => boolean

  constructor(
    private readonly domain: MemoryDomain,
    options: MemoryServiceOptions
  ) {
    const isAutoMemoryEnabled = options.isAutoMemoryEnabled ?? (() => true)
    const isBackgroundGrowthEnabled = options.isBackgroundGrowthEnabled ?? (() => true)
    this.isGrowthEnabled = () => isAutoMemoryEnabled() && isBackgroundGrowthEnabled()
    this.scheduler = new MemoryDreamScheduler(domain, {
      isEnabled: this.isGrowthEnabled,
      allowBatteryGrowth: options.allowBatteryGrowth,
      idleSignal: options.idleSignal,
    })
  }

  public async warmup(): Promise<void> {
    try {
      if (!this.isGrowthEnabled()) {
        this.domain.recoverOrphanDreamRuns()
        return
      }
      const result = this.domain.warmup()
      if (result.state === 'committed') {
        this.log.info('memory tree startup consolidation completed', {
          acceptedCount: result.acceptedCount,
          treeVersion: result.treeVersionAfter,
        })
      }
    } catch (error) {
      // 默认采用容错启动策略；run ledger 已保存失败状态供宿主诊断。
      this.log.warn('memory tree startup consolidation failed', AppError.from(error))
    } finally {
      this.scheduler.start()
    }
  }

  public captureEvidence(input: MemoryEvidenceInput): ReturnType<MemoryDomain['captureEvidence']> {
    return this.domain.captureEvidence(input)
  }

  public recall(query: string, options?: MemoryRecallOptions): MemoryRecallItem[] {
    return this.domain.recall(query, options)
  }

  public runDream(options: MemoryDreamRunOptions): MemoryDreamRunResult {
    return this.domain.runDream(options)
  }

  public runDreamNow(abortSignal?: AbortSignal): MemoryDreamRunResult {
    return this.scheduler.runNow(abortSignal)
  }

  public getTreeState(): MemoryTreeState {
    return this.domain.getTreeState()
  }

  public getTreeStateAtVersion(version: number): MemoryTreeState {
    return this.domain.getTreeStateAtVersion(version)
  }

  public verifyTreeIntegrity(): MemoryTreeIntegrityReport {
    return this.domain.verifyTreeIntegrity()
  }

  public setEvidenceEligibility(
    evidenceId: string,
    state: MemoryEvidenceEligibilityState
  ): MemoryEvidenceEligibilityResult {
    return this.domain.setEvidenceEligibility(evidenceId, state)
  }

  public getDiagnostics(): MemoryTreeDiagnostics {
    return this.domain.getDiagnostics()
  }

  public close(): void {
    this.scheduler.stop()
    // SQLite 连接由 DatabaseManager 统一持有；记忆域没有独立资源需要关闭。
  }
}
