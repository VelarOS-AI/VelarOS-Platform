/**
 * 事务生命周期状态机：`TransactionStateMachine`。接口 `TransactionStateMachineApi` 在本文件的类上方。
 * 规则表与判定在 `utils/transactions/transaction-lifecycle.ts`；这里按规则回答每个命令，内核改事务状态一律经它。
 */

import type { ProjectTransactionExecution, ProjectTransactionExecutionStatus, ProjectTransactionStatus, StoredTransaction } from '../../types/transaction.js'
import { assertConsistentStableState, commandAllowedFrom, invalidTransition, ValidationSuccessTable } from '../../utils/transactions/transaction-lifecycle.js'

/**
 * Project 事务的纯生命周期规则：给出每个命令之后的稳定状态，不合规就抛 INVALID_INPUT（details 带事务号、命令和当前状态）。
 *
 * 不读写文件、不持有事务，也不把执行态写入 durable snapshot。apply/rollback 的 `begin*` 返回一次命令内使用的
 * execution token；成功时由 `commit` 得到新稳定状态，失败时 `abort` 回到 token.from。命令串行化由 TransactionCoordinator 负责。
 * 每个命令都先核对状态与 appliedAt 一致，不一致同样按非法转换抛出。实例由内核持有，一个内核一份。
 */
export interface TransactionStateMachineApi {
  /** 修补（amend）之后的状态：只有 prepared、validated 能修补，修补后一律回到 prepared（之前的校验作废）。 */
  amend(transaction: StoredTransaction): 'prepared'
  /** 校验通过之后的状态：prepared、validated 变成 validated，applied、rolled_back 保持原状。 */
  validationSucceeded(transaction: StoredTransaction): ProjectTransactionStatus
  /** 核对事务能被丢弃：只有尚未应用（prepared、validated）的能丢弃，否则抛出。 */
  assertDiscardable(transaction: StoredTransaction): void
  /** 核对事务能被应用：prepared、validated、rolled_back 能应用，已应用的抛出。 */
  assertApplicable(transaction: StoredTransaction): void
  /** 开始应用：核对能应用后返回这次命令用的执行记号（applying，from 是开始前的状态）。 */
  beginApply(transaction: StoredTransaction): Extract<ProjectTransactionExecution, { command: 'apply' }>
  /** 开始回滚：只有 applied 能回滚，返回这次命令用的执行记号（rolling_back，from 是 applied）。 */
  beginRollback(transaction: StoredTransaction): Extract<ProjectTransactionExecution, { command: 'rollback' }>
  /** 命令成功后的稳定状态：应用得 applied，回滚得 rolled_back。 */
  commit(execution: ProjectTransactionExecution): 'applied' | 'rolled_back'
  /** 命令失败后退回的状态：执行记号里记的开始前状态。 */
  abort(execution: ProjectTransactionExecution): ProjectTransactionStatus
  /** 失败补偿时把状态恢复成事先记下的值：原样返回，只为让每一次状态改写都经过状态机。 */
  restore(status: ProjectTransactionStatus): ProjectTransactionStatus
  /** 是不是终态（applied、rolled_back）：终态事务按终态保留上限淘汰。 */
  isTerminal(status: ProjectTransactionStatus): boolean
  /** 执行记号对应的执行态（applying、rolling_back）；执行态只在命令进行中存在，不落盘。 */
  executionStatus(execution: ProjectTransactionExecution): ProjectTransactionExecutionStatus
}

export class TransactionStateMachine implements TransactionStateMachineApi {
  public amend(transaction: StoredTransaction): 'prepared' {
    assertConsistentStableState(transaction, 'amend')
    if (!commandAllowedFrom('amend', transaction.status))
      return invalidTransition(transaction, 'amend', '只能修补尚未应用的事务')
    return 'prepared'
  }

  public validationSucceeded(transaction: StoredTransaction): ProjectTransactionStatus {
    assertConsistentStableState(transaction, 'validate')
    if (!commandAllowedFrom('validate', transaction.status))
      return invalidTransition(transaction, 'validate', '当前事务状态不能校验')
    return ValidationSuccessTable[transaction.status]
  }

  public assertDiscardable(transaction: StoredTransaction): void {
    assertConsistentStableState(transaction, 'discard')
    if (!commandAllowedFrom('discard', transaction.status)) {
      invalidTransition(transaction, 'discard', '只能丢弃尚未应用的事务')
    }
  }

  public assertApplicable(transaction: StoredTransaction): void {
    assertConsistentStableState(transaction, 'apply')
    if (!commandAllowedFrom('apply', transaction.status)) {
      invalidTransition(transaction, 'apply', '事务已经应用')
    }
  }

  public beginApply(
    transaction: StoredTransaction,
  ): Extract<ProjectTransactionExecution, { command: 'apply' }> {
    this.assertApplicable(transaction)
    return {
      command: 'apply',
      from: transaction.status as 'prepared' | 'validated' | 'rolled_back',
      status: 'applying',
    }
  }

  public beginRollback(
    transaction: StoredTransaction,
  ): Extract<ProjectTransactionExecution, { command: 'rollback' }> {
    assertConsistentStableState(transaction, 'rollback')
    if (!commandAllowedFrom('rollback', transaction.status))
      return invalidTransition(transaction, 'rollback', '只能回滚已应用的事务')
    return {
      command: 'rollback',
      from: 'applied',
      status: 'rolling_back',
    }
  }

  public commit(execution: ProjectTransactionExecution): 'applied' | 'rolled_back' {
    return execution.command === 'apply' ? 'applied' : 'rolled_back'
  }

  public abort(execution: ProjectTransactionExecution): ProjectTransactionStatus {
    return execution.from
  }

  public restore(status: ProjectTransactionStatus): ProjectTransactionStatus {
    return status
  }

  public isTerminal(status: ProjectTransactionStatus): boolean {
    return status === 'applied' || status === 'rolled_back'
  }

  public executionStatus(
    execution: ProjectTransactionExecution,
  ): ProjectTransactionExecutionStatus {
    return execution.status
  }
}
