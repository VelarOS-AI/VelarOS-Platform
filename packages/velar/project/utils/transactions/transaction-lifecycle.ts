/**
 * 事务生命周期规则：每个命令能从哪些稳定状态开始、校验通过后落到哪个状态、状态与 appliedAt 是否一致。
 * 两张表是规则本身的数据，和判定写在一起；`TransactionStateMachine` 只按这里的规则回答，不另存一份。
 */

import { isPresent } from '@velaros-ai/core'

import type { ProjectTransactionCommand, ProjectTransactionStatus, StoredTransaction } from '../../types/transaction.js'
import { ProjectError } from '../errors.js'

/** 命令可以从哪些稳定状态开始；运行期额外不变量（如 appliedAt）由状态机一并检查。 */
export const ProjectTransactionCommandTable = Object.freeze({
  amend: Object.freeze(['prepared', 'validated']),
  validate: Object.freeze(['prepared', 'validated', 'applied', 'rolled_back']),
  apply: Object.freeze(['prepared', 'validated', 'rolled_back']),
  rollback: Object.freeze(['applied']),
  discard: Object.freeze(['prepared', 'validated']),
} as const satisfies Readonly<
  Record<ProjectTransactionCommand, readonly ProjectTransactionStatus[]>
>)

/** 校验通过后事务落到哪个稳定状态：尚未应用的升为 validated，已应用、已回滚的保持原状。 */
export const ValidationSuccessTable = Object.freeze({
  prepared: 'validated',
  validated: 'validated',
  applied: 'applied',
  rolled_back: 'rolled_back',
} as const satisfies Readonly<Record<ProjectTransactionStatus, ProjectTransactionStatus>>)

/** 判断命令能不能从这个稳定状态开始（查 ProjectTransactionCommandTable）。 */
export function commandAllowedFrom(command: ProjectTransactionCommand, status: ProjectTransactionStatus): boolean {
  return (ProjectTransactionCommandTable[command] as readonly ProjectTransactionStatus[]).includes(
    status,
  )
}

/** 按非法状态转换抛出 INVALID_INPUT：消息后接事务号，details 带命令与当前状态，建议先读最新状态再走允许的下一步。 */
export function invalidTransition(
  transaction: StoredTransaction,
  command: ProjectTransactionCommand,
  message: string,
): never {
  throw new ProjectError(
    'INVALID_INPUT',
    `${message}：${transaction.transactionId}`,
    { transactionId: transaction.transactionId, command, status: transaction.status },
    '请读取最新事务状态，并只执行该状态允许的下一步操作。',
  )
}

/** 核对状态与 appliedAt 一致：applied、rolled_back 必须带 appliedAt，其余状态必须不带；不一致按非法转换抛出。 */
export function assertConsistentStableState(
  transaction: StoredTransaction,
  command: ProjectTransactionCommand,
): void {
  const hasAppliedAt = isPresent(transaction.appliedAt)
  const expectsAppliedAt = transaction.status === 'applied' || transaction.status === 'rolled_back'
  if (hasAppliedAt !== expectsAppliedAt) {
    invalidTransition(transaction, command, '事务状态与 appliedAt 不一致')
  }
}
