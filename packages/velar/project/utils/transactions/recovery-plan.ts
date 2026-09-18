/**
 * 事务恢复计划：apply、rollback 写盘前落下的恢复点——每个改动路径的原状态和本事务可能留下的状态，恢复时据此判断当前内容归不归本事务。
 */

import { isEmpty, isString } from '@velaros-ai/core'

import type { FileSnapshot } from '../../types/snapshot.js'
import type { ApplyRestoreState, ProjectTransactionFileState, ProjectTransactionPendingOperation, ProjectTransactionRestoreEntry,StoredTransaction, TransactionBytePlan } from '../../types/transaction.js'
import { ProjectError } from '../errors.js'

import { bytePatchFor } from './byte-plan.js'
import { isDeletePatch } from './patch-chain.js'
import { createsMissingFile } from './patch-ownership.js'

/** 本事务按 kind 方向写某个路径时会依次留下的状态：apply 取写后正文、删除补丁留下不存在，rollback 取原文、撤销新建留下不存在；带字节计划里对应的字节。 */
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

/**
 * 为 apply 或 rollback 建落盘的恢复计划：每个改动路径的原状态（存在的带原文、原字节、编码、权限）和本事务可能留下的状态。
 * 有路径捕获不到可还原的原文、或找不到本事务留下的状态，抛 PATCH_APPLY_ERROR。
 */
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

/** 快照是不是这个状态：都不存在算对上；存在的要是非目录、非二进制且正文完全相同。 */
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
