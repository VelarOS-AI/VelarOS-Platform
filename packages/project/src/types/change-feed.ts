/**
 * 事务变更流的数据：一次受治理事务的最新投影、它的补丁与版本，以及编辑器、工作台、审计视图读取变更流的接口。
 */

import type { RiskLevel } from './common.js'
import type { EditIntent } from './edit.js'

export type ProjectChangeLifecycle =
  | 'prepared'
  | 'amended'
  | 'validated'
  | 'validation_failed'
  | 'applied'
  | 'rolled_back'
  | 'discarded'

export interface ProjectChangeRevision {
  readonly path: string
  readonly before?: string
  readonly after?: string
}

export interface ProjectChangePatch {
  readonly patchId: string
  readonly strategyId: string
  readonly path: string
  readonly baseRevision?: string
  readonly diff: string
  readonly changedLines: number
  readonly risk: RiskLevel
  readonly operation?: string
}

/**
 * Latest durable projection of one governed project transaction.
 *
 * It intentionally omits old/new full file contents and arbitrary transaction
 * metadata. Consumers receive typed intents, reviewable patches and revisions;
 * secrets or host-only bookkeeping do not become an accidental evidence copy.
 */
export interface ProjectChangeRecord {
  readonly transactionId: string
  readonly sequence: number
  readonly lifecycle: ProjectChangeLifecycle
  readonly reason?: string
  readonly intents: readonly EditIntent[]
  readonly patches: readonly ProjectChangePatch[]
  readonly changedFiles: readonly string[]
  readonly diff: string
  readonly changedLines: number
  readonly risk: RiskLevel
  readonly revisions: readonly ProjectChangeRevision[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly appliedAt?: number
}

export interface ProjectChangeListOptions {
  readonly beforeSequence?: number
  readonly limit?: number
}

export type ProjectChangeListener = (change: ProjectChangeRecord) => void

export type ProjectChangeRecordInput = Omit<ProjectChangeRecord, 'sequence' | 'updatedAt'>

