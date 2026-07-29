import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  MemoryDomain,
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
} from '@velaros-ai/memory'

import { MemoryDreamScheduler } from './DreamScheduler'
import type { HostIdleSignalPort } from './HostSignals'

interface MemoryServiceOptions {
  /** 空闲/电池/前台读数端口；Dream 调度器判定后台整理时机时消费。 */
  idleSignal: HostIdleSignalPort
  isAutoMemoryEnabled?: () => boolean
  isBackgroundGrowthEnabled?: () => boolean
  allowBatteryGrowth?: () => boolean
}

/** 任意宿主用于管理记忆树生命周期与治理操作的门面。 */
export class MemoryService {
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

export type { MemoryServiceOptions }
