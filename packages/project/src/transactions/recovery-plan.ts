import { isEmpty, isString } from '@velaros-ai/core'

import { ProjectError } from '../errors.js'
import {
  type ProjectTransactionFileState,
  type ProjectTransactionPendingOperation,
  type ProjectTransactionRestoreEntry,
} from '../persistence/transaction-state.js'
import type { FileSnapshot } from '../types/snapshot.js'
import type { StoredTransaction } from '../types/transaction.js'
import { type ProjectTextEncoding } from '../utils/text.js'

import type { TransactionBytePlan } from './byte-plan.js'
import { bytePatchFor } from './byte-plan.js'
import { createsMissingFile } from './patch-ownership.js'
import { isDeletePatch } from './transaction-overlay.js'

/** applyEdit 失败回滚所需的单个路径原始状态。 */
export interface ApplyRestoreState {
  existedBefore: boolean
  oldContent?: string
  bytes?: string
  /** 原文件的文本编码；还原时文件若已被删掉，按它重建而不是写成 UTF-8。 */
  encoding?: ProjectTextEncoding
  mode?: number
  restorable: boolean
}

export function transactionOwnedStates(
  tx: StoredTransaction,
  kind: ProjectTransactionPendingOperation['kind'],
  pathValue: string,
  bytePlan?: TransactionBytePlan,
): ProjectTransactionFileState[] {
  const patches = kind === 'apply' ? tx.patches : [...tx.patches].reverse()
  const states: ProjectTransactionFileState[] = []
  for (const patchValue of patches) {
    if (patchValue.path !== pathValue) continue
    const deletes = kind === 'apply' ? isDeletePatch(patchValue) : createsMissingFile(patchValue)
    states.push(
      deletes
        ? { exists: false }
        : {
            exists: true,
            bytes: kind === 'apply' ? bytePatchFor(bytePlan, patchValue)?.after : bytePatchFor(bytePlan, patchValue)?.before,
            content:
              kind === 'apply' ? (patchValue.newContent ?? '') : (patchValue.oldContent ?? ''),
          },
    )
  }
  return states
}

export function durableRestorePlan(
  tx: StoredTransaction,
  kind: ProjectTransactionPendingOperation['kind'],
  restoreByPath: Map<string, ApplyRestoreState>,
  bytePlan?: TransactionBytePlan,
): ProjectTransactionRestoreEntry[] {
  const plan: ProjectTransactionRestoreEntry[] = []
  for (const pathValue of tx.changedFiles) {
    const restore = restoreByPath.get(pathValue)
    if (!restore?.restorable || (restore.existedBefore && !isString(restore.oldContent))) {
      throw new ProjectError(
        'PATCH_APPLY_ERROR',
        `事务 ${tx.transactionId} 无法建立可恢复写盘计划：${pathValue}`,
        { transactionId: tx.transactionId, path: pathValue, operation: kind },
        '请把二进制或超限文件拆出该事务；可恢复事务只写入能够完整捕获旧正文的文件。',
      )
    }
    const ownedStates = transactionOwnedStates(tx, kind, pathValue, bytePlan)
    if (isEmpty(ownedStates)) {
      throw new ProjectError(
        'PATCH_APPLY_ERROR',
        `事务 ${tx.transactionId} 的路径缺少可验证写盘状态：${pathValue}`,
        { transactionId: tx.transactionId, path: pathValue, operation: kind },
      )
    }
    plan.push({
      path: pathValue,
      exists: restore.existedBefore,
      ...(restore.existedBefore
        ? { content: restore.oldContent!, bytes: restore.bytes, encoding: restore.encoding, mode: restore.mode }
        : {}),
      ownedStates,
    })
  }
  return plan
}

export function fileStateMatches(
  snapshot: FileSnapshot,
  state: ProjectTransactionFileState,
): boolean {
  if (!state.exists) return !snapshot.exists
  return (
    snapshot.exists &&
    !snapshot.isDirectory &&
    !snapshot.isBinary &&
    snapshot.content === state.content
  )
}

/** 恢复写入会生成新的 revision；仅刷新已验证恢复成功的路径首个补丁。 */
export function refreshRecoveredBaseRevisions(
  transaction: StoredTransaction,
  recovered: ReadonlyMap<string, FileSnapshot>,
): void {
  const seen = new Set<string>()
  transaction.patches = transaction.patches.map((patch) => {
    const snapshot = recovered.get(patch.path)
    if (!snapshot || seen.has(patch.path)) return patch
    seen.add(patch.path)
    return { ...patch, baseRevision: snapshot.revision }
  })
  transaction.baseSnapshots = transaction.baseSnapshots.map((snapshot) => recovered.get(snapshot.path) ?? snapshot)
}
