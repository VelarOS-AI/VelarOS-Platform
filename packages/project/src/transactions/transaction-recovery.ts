import { isString, optionalWhen } from '@velaros-ai/core'

import { ProjectError } from '../errors.js'
import { type ProjectTransactionPendingOperation } from '../persistence/transaction-state.js'
import type { ProjectFileAccess } from '../types/file-access.js'
import type { StoredTransaction } from '../types/transaction.js'

import { type ApplyRestoreState, durableRestorePlan, fileStateMatches } from './recovery-plan.js'
interface TransactionRecoveryDependencies {
  readonly store: Pick<ProjectFileAccess, 'snapshot' | 'write' | 'remove'>
}
export class TransactionRecovery {
  constructor(private readonly dependencies: TransactionRecoveryDependencies) {}

  /** 写盘前捕获每个受影响路径的原始状态，供 apply 失败时回滚（只读，不改写盘语义）。 */
  public async captureApplyRestoreState(
    paths: readonly string[],
  ): Promise<Map<string, ApplyRestoreState>> {
    const restoreByPath = new Map<string, ApplyRestoreState>()
    for (const file of paths) {
      if (restoreByPath.has(file)) continue
      const before = await this.dependencies.store.snapshot(file, true, { skipFileFilter: true })
      restoreByPath.set(file, {
        existedBefore: before.exists && !before.isDirectory,
        // 仅文本文件可按字符串还原；二进制/超限文件无法捕获正文，回滚时尽力而为。
        oldContent: optionalWhen(isString(before.content), before.content),
        encoding: before.textEncoding,
        restorable: isString(before.content) || !before.exists || before.isDirectory,
      })
    }
    return restoreByPath
  }

  /** 内存事务也使用内容归属预检；失败恢复不能覆盖此间发生的外部编辑。 */
  public async restoreAppliedFiles(
    writtenOrder: readonly string[],
    restoreByPath: Map<string, ApplyRestoreState>,
    transaction: StoredTransaction,
    kind: ProjectTransactionPendingOperation['kind'],
  ): Promise<void> {
    const attempted = { ...transaction, changedFiles: [...new Set(writtenOrder)] }
    await this.restore({
      transactionId: transaction.transactionId,
      previousStatus: transaction.status,
      kind,
      restore: durableRestorePlan(attempted, kind, restoreByPath),
    })
  }
  public async restore(pending: ProjectTransactionPendingOperation): Promise<void> {
    const writes: Array<ProjectTransactionPendingOperation['restore'][number]> = []
    for (const restore of [...pending.restore].reverse()) {
      const current = await this.dependencies.store.snapshot(restore.path, true, {
        skipFileFilter: true,
      })
      if (fileStateMatches(current, restore)) continue
      if (!restore.ownedStates.some((state) => fileStateMatches(current, state))) {
        throw new ProjectError(
          'TRANSACTION_RECOVERY_CONFLICT',
          `事务恢复拒绝覆盖无法归属于本事务的外部内容：${restore.path}`,
          {
            transactionId: pending.transactionId,
            operation: pending.kind,
            path: restore.path,
            actualRevision: current.revision,
          },
          '请先人工保全当前文件，再决定保留外部内容还是事务恢复点。',
        )
      }
      writes.push(restore)
    }
    // 先检查全部路径，避免发现后面的外部冲突时，前面的文件已经被恢复。
    for (const restore of writes) {
      if (restore.exists) {
        await this.dependencies.store.write(restore.path, restore.content!, {
          skipFileFilter: true,
          encoding: restore.encoding,
        })
      } else {
        await this.dependencies.store.remove(restore.path, { skipFileFilter: true })
      }
    }
  }
}
