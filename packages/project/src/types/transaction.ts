import type { PreparedTransaction } from "./edit.js";

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
