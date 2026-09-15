import type { TextEncoding } from '@velaros-ai/text-files/contracts'

import type { ProjectChangeRecordInput } from './change-feed.js'
import type { Diagnostic } from './common.js'
import type { PreparedTransaction } from "./edit.js";
import type { FileAttributes } from './snapshot.js'

export type ProjectTransactionCommand = 'amend' | 'validate' | 'apply' | 'rollback' | 'discard'

export type ProjectTransactionExecution =
  | {
      readonly command: 'apply'
      readonly from: 'prepared' | 'validated' | 'rolled_back'
      readonly status: 'applying'
    }
  | {
      readonly command: 'rollback'
      readonly from: 'applied'
      readonly status: 'rolling_back'
    }

export type StagedFileContent = Nullable<string>

export interface TransactionContentOverlay {
  readonly contentByPath: Map<string, StagedFileContent>
  readonly attributesByPath: Map<string, FileAttributes>
  readonly diagnostics: Diagnostic[]
}

export interface ActiveTransactionCommand {
  active: boolean
  transactionId: string
}

/** 覆盖事务将要修改的相对路径的内存锁。 */
export interface ProjectLock {
  lockId: string
  owner: string
  paths: string[]
  createdAt: number
}

export interface PendingProjectLock {
  lock: ProjectLock
  resolve: (lock: ProjectLock) => void
}

export type ProjectTransactionOperationKind = 'apply' | 'rollback'

export interface ProjectTransactionFileState {
  readonly exists: boolean
  readonly content?: string
  readonly bytes?: string
}

export interface ProjectTransactionRestoreEntry extends ProjectTransactionFileState {
  readonly path: string
  /** 原文件的文本编码（非无 BOM UTF-8 时记下）；恢复时文件已被删掉就按它重建。 */
  readonly encoding?: TextEncoding
  readonly mode?: number
  readonly ownedStates: readonly ProjectTransactionFileState[]
}

export interface ProjectTransactionPendingOperation {
  readonly kind: ProjectTransactionOperationKind
  readonly transactionId: string
  readonly previousStatus: StoredTransaction['status']
  readonly restore: readonly ProjectTransactionRestoreEntry[]
}

export interface ProjectTransactionStateSnapshot {
  readonly formatVersion: 1 | 2
  readonly revision: number
  readonly root: string
  readonly transactions: readonly StoredTransaction[]
  readonly projections: readonly ProjectChangeRecordInput[]
  readonly pending?: ProjectTransactionPendingOperation
  readonly bytePlans?: readonly TransactionBytePlan[]
}

/** applyEdit 失败回滚所需的单个路径原始状态。 */
export interface ApplyRestoreState {
  existedBefore: boolean
  oldContent?: string
  bytes?: string
  /** 原文件的文本编码；还原时文件若已被删掉，按它重建而不是写成 UTF-8。 */
  encoding?: TextEncoding
  mode?: number
  restorable: boolean
}

/** 私有持久化记录；不会附加到补丁、快照或模型回执。 */
export interface TransactionBytePatch {
  readonly patchId: string;
  readonly path: string;
  readonly before?: string;
  readonly beforeUnavailable?: true;
  readonly after?: string;
}

export interface TransactionBytePlan {
  readonly transactionId: string;
  readonly patches: readonly TransactionBytePatch[];
}

export interface ProjectTransactionInput {
  readonly transactionId: string
}

/** Project 持久化、运行时与公开查询共享的稳定事务生命周期状态。 */
export type ProjectTransactionStatus =
  | PreparedTransaction["status"]
  | "validated"
  | "applied"
  | "rolled_back";

/** 只存在于一次命令执行期间、不写入 durable snapshot 的事务阶段。 */
export type ProjectTransactionExecutionStatus = "applying" | "rolling_back";

/** 状态机可以观察到的完整生命周期；执行态由 TransactionCoordinator 串行保护。 */
export type ProjectTransactionLifecycleStatus =
  | ProjectTransactionStatus
  | ProjectTransactionExecutionStatus;

/**
 * getTransaction、内核内存表和持久化事务状态共享的真实事务形状。
 * `PreparedTransaction.status` 只描述刚完成 prepare 的结果，后续稳定生命周期由本类型表达。
 */
export type StoredTransaction = Omit<PreparedTransaction, "status"> & {
  status: ProjectTransactionStatus;
  appliedAt?: number;
};
