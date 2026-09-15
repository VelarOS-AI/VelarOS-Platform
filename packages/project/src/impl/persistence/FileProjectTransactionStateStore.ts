/**
 * 事务状态文件：`FileProjectTransactionStateStore`。接口 `FileProjectTransactionStateStoreApi` 与构造参数 `FileProjectTransactionStateStoreOptions` 在本文件的类上方。
 * 状态的格式版本与逐项校验在 `utils/transactions/transaction-state.ts`，防护上限在 `ProjectTuning.persistence`。
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

import { isUndefined, toOptional } from '@velaros-ai/core'

import type { ProjectChangeRecordInput } from '../../types/change-feed.js'
import type { ProjectTransactionPendingOperation, ProjectTransactionStateSnapshot, StoredTransaction, TransactionBytePlan } from '../../types/transaction.js'
import { assertTransactionStateSize, assertTransactionStateSnapshot, cloneTransactionState, invalidTransactionState, TransactionStateFormatVersions } from '../../utils/transactions/transaction-state.js'

/** 事务状态文件的构造参数。 */
export interface FileProjectTransactionStateStoreOptions {
  /** 状态文件路径：宿主私有、在项目目录树之外。 */
  readonly path: string
  /** 这份状态允许管的项目根（规范化后的绝对路径）；读回的状态根目录对不上就拒绝加载。 */
  readonly root: string
}

/**
 * 宿主私有、整份原子替换的事务状态：内存事务、变更投影、字节计划与未完成操作的恢复点，内核重启后据此恢复。
 *
 * 项目文件与这份状态不在同一个文件系统事务里；`pending.restore` 是先落盘的恢复边界，apply、rollback 中途被打断后，
 * 下一次持有者启动时据此恢复。读回和写入都逐项校验，任何一项不合规抛 TRANSACTION_RECOVERY_CONFLICT（按状态文件损坏处理）。
 * 实例由内核在宿主给了 transactionStatePath 时创建，一个内核一份。
 */
export interface FileProjectTransactionStateStoreApi {
  /** 状态文件的绝对路径。 */
  readonly path: string
  /** 这份状态绑定的项目根（绝对路径）。 */
  readonly root: string
  /** 当前状态的深拷贝（文件不存在时是 revision 0 的空状态）。 */
  snapshot(): ProjectTransactionStateSnapshot
  /**
   * 写入下一版状态（revision 加一，按现行格式版本）：先校验整份状态与大小上限，再原子替换文件（临时文件 fsync 后改名，POSIX 上再刷父目录），
   * 返回写后状态的深拷贝。校验不过抛 TRANSACTION_RECOVERY_CONFLICT，写盘失败原样抛出，两种情况文件都保持原样。
   */
  commit(input: {
    readonly transactions: readonly StoredTransaction[]
    readonly projections: readonly ProjectChangeRecordInput[]
    readonly pending?: ProjectTransactionPendingOperation
    readonly bytePlans?: readonly TransactionBytePlan[]
  }): ProjectTransactionStateSnapshot
}

export class FileProjectTransactionStateStore implements FileProjectTransactionStateStoreApi {
  /** 状态文件所在目录的权限：只有宿主用户能进。 */
  private static readonly DirectoryMode = 0o700
  /** 状态文件的权限：只有宿主用户能读写。 */
  private static readonly FileMode = 0o600
  public readonly path: string
  public readonly root: string
  private current: ProjectTransactionStateSnapshot

  public constructor(options: FileProjectTransactionStateStoreOptions) {
    this.path = resolve(options.path)
    this.root = resolve(options.root)
    mkdirSync(dirname(this.path), { recursive: true, mode: FileProjectTransactionStateStore.DirectoryMode })
    this.current = this.load()
  }

  private empty(): ProjectTransactionStateSnapshot {
    return {
      formatVersion: TransactionStateFormatVersions.current,
      revision: 0,
      root: this.root,
      transactions: [],
      projections: [],
    }
  }

  private load(): ProjectTransactionStateSnapshot {
    if (!existsSync(this.path)) return this.empty()
    const metadata = lstatSync(this.path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) invalidTransactionState('state path must be a regular file')
    assertTransactionStateSize(statSync(this.path).size)
    const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
    assertTransactionStateSnapshot(parsed, this.root)
    return cloneTransactionState(parsed)
  }

  public snapshot(): ProjectTransactionStateSnapshot {
    return cloneTransactionState(this.current)
  }

  public commit(input: {
    readonly transactions: readonly StoredTransaction[]
    readonly projections: readonly ProjectChangeRecordInput[]
    readonly pending?: ProjectTransactionPendingOperation
    readonly bytePlans?: readonly TransactionBytePlan[]
  }): ProjectTransactionStateSnapshot {
    const next: ProjectTransactionStateSnapshot = {
      formatVersion: TransactionStateFormatVersions.current,
      revision: this.current.revision + 1,
      root: this.root,
      transactions: input.transactions,
      projections: input.projections,
      pending: toOptional(input.pending),
      bytePlans: input.bytePlans,
    }
    const source = JSON.stringify(next)
    assertTransactionStateSize(new TextEncoder().encode(source).byteLength)
    const parsed: unknown = JSON.parse(source)
    assertTransactionStateSnapshot(parsed, this.root)
    this.writeAtomic(source)
    this.current = cloneTransactionState(parsed)
    return this.snapshot()
  }

  private writeAtomic(source: string): void {
    const directory = dirname(this.path)
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        FileProjectTransactionStateStore.FileMode,
      )
      writeFileSync(descriptor, source, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporaryPath, this.path)
      // Windows 上 Node 不能打开目录句柄做 fsync。文件本身在上面已经落盘；
      // POSIX 宿主再刷一次父目录，让 rename 在崩溃后也不会丢。
      if (process.platform !== 'win32') {
        const directoryDescriptor = openSync(directory, constants.O_RDONLY)
        try {
          fsyncSync(directoryDescriptor)
        } finally {
          closeSync(directoryDescriptor)
        }
      }
    } catch (error) {
      if (!isUndefined(descriptor)) closeSync(descriptor)
      try {
        unlinkSync(temporaryPath)
      } catch {
        // arch-guard:silent-catch-ok 原子写失败最多留下一个没人引用的临时文件。
      }
      throw error
    }
  }
}
