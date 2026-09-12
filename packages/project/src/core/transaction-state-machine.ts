import { isPresent } from "@velaros-ai/core";

import { ProjectError } from "../errors.js";
import type {
  ProjectTransactionExecutionStatus,
  ProjectTransactionStatus,
  StoredTransaction,
} from "../types/transaction.js";

export type ProjectTransactionCommand =
  | "amend"
  | "validate"
  | "apply"
  | "rollback"
  | "discard";

export type ProjectTransactionExecution =
  | {
      readonly command: "apply";
      readonly from: "prepared" | "validated" | "rolled_back";
      readonly status: "applying";
    }
  | {
      readonly command: "rollback";
      readonly from: "applied";
      readonly status: "rolling_back";
    };

/** 命令可以从哪些稳定状态开始；运行期额外不变量（如 appliedAt）由状态机一并检查。 */
export const ProjectTransactionCommandTable = Object.freeze({
  amend: Object.freeze(["prepared", "validated"]),
  validate: Object.freeze(["prepared", "validated", "applied", "rolled_back"]),
  apply: Object.freeze(["prepared", "validated", "rolled_back"]),
  rollback: Object.freeze(["applied"]),
  discard: Object.freeze(["prepared", "validated"]),
} as const satisfies Readonly<Record<ProjectTransactionCommand, readonly ProjectTransactionStatus[]>>);

const ValidationSuccessTable = Object.freeze({
  prepared: "validated",
  validated: "validated",
  applied: "applied",
  rolled_back: "rolled_back",
} as const satisfies Readonly<Record<ProjectTransactionStatus, ProjectTransactionStatus>>);

function allows(command: ProjectTransactionCommand, status: ProjectTransactionStatus): boolean {
  return (ProjectTransactionCommandTable[command] as readonly ProjectTransactionStatus[]).includes(status);
}

function invalidTransition(
  transaction: StoredTransaction,
  command: ProjectTransactionCommand,
  message: string,
): never {
  throw new ProjectError(
    "INVALID_INPUT",
    `${message}：${transaction.transactionId}`,
    { transactionId: transaction.transactionId, command, status: transaction.status },
    "请读取最新事务状态，并只执行该状态允许的下一步操作。",
  );
}

function assertConsistentStableState(
  transaction: StoredTransaction,
  command: ProjectTransactionCommand,
): void {
  const hasAppliedAt = isPresent(transaction.appliedAt);
  const expectsAppliedAt = transaction.status === "applied" || transaction.status === "rolled_back";
  if (hasAppliedAt !== expectsAppliedAt) {
    invalidTransition(transaction, command, "事务状态与 appliedAt 不一致");
  }
}

/**
 * Project 事务的纯生命周期规则。
 *
 * 该状态机不读写文件、不持有事务，也不把执行态写入 durable snapshot。apply/rollback 的
 * `begin*` 返回一次命令内使用的 execution token；成功时由 `commit` 得到新稳定状态，失败时
 * `abort` 回到 token.from。命令串行化仍由 TransactionCoordinator 负责。
 */
export class TransactionStateMachine {
  public amend(transaction: StoredTransaction): "prepared" {
    assertConsistentStableState(transaction, "amend");
    if (!allows("amend", transaction.status))
      return invalidTransition(transaction, "amend", "只能修补尚未应用的事务");
    return "prepared";
  }

  public validationSucceeded(transaction: StoredTransaction): ProjectTransactionStatus {
    assertConsistentStableState(transaction, "validate");
    if (!allows("validate", transaction.status))
      return invalidTransition(transaction, "validate", "当前事务状态不能校验");
    return ValidationSuccessTable[transaction.status];
  }

  public assertDiscardable(transaction: StoredTransaction): void {
    assertConsistentStableState(transaction, "discard");
    if (!allows("discard", transaction.status)) {
      invalidTransition(transaction, "discard", "只能丢弃尚未应用的事务");
    }
  }

  public assertApplicable(transaction: StoredTransaction): void {
    assertConsistentStableState(transaction, "apply");
    if (!allows("apply", transaction.status)) {
      invalidTransition(transaction, "apply", "事务已经应用");
    }
  }

  public beginApply(transaction: StoredTransaction): Extract<ProjectTransactionExecution, { command: "apply" }> {
    this.assertApplicable(transaction);
    return {
      command: "apply",
      from: transaction.status as "prepared" | "validated" | "rolled_back",
      status: "applying",
    };
  }

  public beginRollback(transaction: StoredTransaction): Extract<ProjectTransactionExecution, { command: "rollback" }> {
    assertConsistentStableState(transaction, "rollback");
    if (!allows("rollback", transaction.status))
      return invalidTransition(transaction, "rollback", "只能回滚已应用的事务");
    return {
      command: "rollback",
      from: "applied",
      status: "rolling_back",
    };
  }

  public commit(execution: ProjectTransactionExecution): "applied" | "rolled_back" {
    return execution.command === "apply" ? "applied" : "rolled_back";
  }

  public abort(execution: ProjectTransactionExecution): ProjectTransactionStatus {
    return execution.from;
  }

  public restore(status: ProjectTransactionStatus): ProjectTransactionStatus {
    return status;
  }

  public isTerminal(status: ProjectTransactionStatus): boolean {
    return status === "applied" || status === "rolled_back";
  }

  public executionStatus(execution: ProjectTransactionExecution): ProjectTransactionExecutionStatus {
    return execution.status;
  }
}
