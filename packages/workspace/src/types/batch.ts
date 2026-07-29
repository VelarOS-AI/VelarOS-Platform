import type { ApplyEditInput, PreparedTransaction,PrepareEditInput, RollbackInput } from "./edit.js";
import type { ReadInput, SearchInput } from "./io.js";
import type { ResolveTargetInput } from "./target.js";
import type { ValidateInput } from "./validation.js";

/** runner 可以在依赖图中调度的批处理操作类型。 */
export type BatchTaskOperation =
  | { kind: "read"; input: ReadInput }
  | { kind: "search"; input: SearchInput }
  | { kind: "resolve"; input: ResolveTargetInput }
  | { kind: "prepare"; input: PrepareEditInput }
  | { kind: "apply"; input: ApplyEditInput }
  | { kind: "validate"; input: ValidateInput }
  | { kind: "rollback"; input: RollbackInput }
  | { kind: "custom"; run: () => Promise<any> | any; resources?: string[] };

export interface BatchTask {
  id: string;
  /** 当前任务运行前必须成功完成的任务 id。 */
  dependsOn?: string[];
  /** custom 操作触碰共享资源时使用的额外逻辑锁。 */
  resources?: string[];
  op: BatchTaskOperation;
}

export interface BatchConflict {
  taskA: string;
  taskB: string;
  file: string;
  reason: "SAME_FILE" | "OVERLAPPING_RANGE" | "DELETE_MODIFY" | "RESOURCE_LOCK";
  details?: any;
}

export interface BatchInput {
  tasks: BatchTask[];
  /** runner 内部会再受 CorePolicy.maxConcurrentBatchTasks 约束。 */
  concurrency?: number;
  stopOnError?: boolean;
  atomic?: boolean;
  /**
   * dag：依赖满足后立即执行任务。
   * prepare-then-apply：先运行所有非 apply 任务，检测 prepared transaction 冲突后再运行 apply 任务。
   */
  mode?: "dag" | "prepare-then-apply";
  conflictCheck?: boolean;
}

export interface BatchTaskResult {
  id: string;
  ok: boolean;
  result?: any;
  error?: any;
  startedAt: number;
  finishedAt: number;
}

/** 批处理工作池的运行指标，用于观测并发利用率与排队压力。 */
export interface BatchMetrics {
  /** 进入结果的任务总数。 */
  totalTasks: number;
  /** 本次实际生效的并发上限。 */
  concurrencyLimit: number;
  /** 同时在飞任务的峰值（反映真实并行度）。 */
  peakActive: number;
  /** 因并发上限被迫等待的「就绪任务」峰值（>0 说明提高并发可能有收益）。 */
  maxQueuedReady: number;
  /** 整批墙钟耗时（毫秒）。 */
  durationMs: number;
}

export interface BatchResult {
  ok: boolean;
  results: BatchTaskResult[];
  conflicts?: BatchConflict[];
  rolledBackTransactions: string[];
  /**
   * atomic 回滚阶段中回滚失败的事务（连同错误）。回滚失败不会覆盖原 batch 结果，
   * 但必须显式上报：否则调用方会误以为 atomic 已完整撤销，而磁盘上仍残留这些事务的写入。
   */
  rollbackFailures?: Array<{ transactionId: string; error: any }>;
  preparedTransactions?: PreparedTransaction[];
  metrics?: BatchMetrics;
}
