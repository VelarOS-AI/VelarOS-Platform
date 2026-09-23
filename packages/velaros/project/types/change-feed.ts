/**
 * 事务变更流的数据：一次受治理事务的最新投影、它的补丁与版本，以及编辑器、工作台、审计视图读取变更流的接口。
 */

import type { RiskLevel } from './common.js'
import type { EditIntent } from './edit.js'

/** 落盘变更记录的选项。 */
export interface FileProjectChangeFeedOptions {
  /** 记录文件的路径；放在宿主私有目录，不要放进项目树。 */
  readonly path: string
}

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
 * 一个受治理项目事务的最新落盘投影。
 *
 * 有意不带新旧全文和任意的事务元数据：消费方拿到的是有类型的意图、可审阅的补丁和版本，
 * 密钥或宿主私有的记账不会意外变成一份证据副本。
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
