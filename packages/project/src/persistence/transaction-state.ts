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

import {
  isArray,
  isBoolean,
  isFiniteNumber,
  isNumber,
  isRecord,
  isString,
  isTrue,
  isUndefined,
  toOptional,
} from '@velaros-ai/core'

import { ProjectError } from '../errors.js'
import type { TransactionBytePlan } from '../transactions/byte-plan.js'
import { createsMissingFile } from '../transactions/patch-ownership.js'
import { isDeletePatch } from '../transactions/transaction-overlay.js'
import type { StoredTransaction } from '../types/transaction.js'
import { decodeProjectTextBuffer } from '../utils/text.js'
import { isProjectTextEncoding, type ProjectTextEncoding } from '../utils/text.js'

import type { ProjectChangeRecordInput } from './change-feed.js'

const StateFormatVersion = 2
const MaximumStateBytes = 256 * 1024 * 1024
const MaximumTransactions = 1000
const MaximumPatchesPerTransaction = 10_000
const MaximumChangedFilesPerTransaction = 10_000
const MaximumContentBytes = 16 * 1024 * 1024
const MaximumIdentifierBytes = 512
const MaximumPathBytes = 16 * 1024

export type ProjectTransactionOperationKind = 'apply' | 'rollback'

export interface ProjectTransactionFileState {
  readonly exists: boolean
  readonly content?: string
  readonly bytes?: string
}

export interface ProjectTransactionRestoreEntry extends ProjectTransactionFileState {
  readonly path: string
  /** 原文件的文本编码（非无 BOM UTF-8 时记下）；恢复时文件已被删掉就按它重建。 */
  readonly encoding?: ProjectTextEncoding
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

export interface FileProjectTransactionStateStoreOptions {
  /** Host-owned path outside the project tree. */
  readonly path: string
  /** Canonical project root this state is allowed to control. */
  readonly root: string
}

function fail(message: string): never {
  throw new ProjectError(
    'TRANSACTION_RECOVERY_CONFLICT',
    `Invalid project transaction state: ${message}`,
    { stateValidationFailure: message },
    '请保全事务状态文件和项目目录，不要删除或重写任一侧；先确认损坏来源再人工恢复。',
  )
}

function boundedString(value: unknown, maximum: number, label: string): asserts value is string {
  if (!isString(value) || new TextEncoder().encode(value).byteLength > maximum) fail(label)
}

function optionalBoundedString(value: unknown, maximum: number, label: string): void {
  if (!isUndefined(value)) boundedString(value, maximum, label)
}

function isRisk(value: unknown): boolean {
  return value === 'low' || value === 'medium' || value === 'high'
}

function assertStringArray(
  value: unknown,
  maximum: number,
  label: string,
): asserts value is string[] {
  if (!isArray(value) || value.length > maximum) fail(label)
  for (const item of value) boundedString(item, MaximumPathBytes, label)
}

function assertPatch(value: unknown): void {
  if (!isRecord(value)) fail('patch must be an object')
  boundedString(value.patchId, MaximumIdentifierBytes, 'patch id')
  boundedString(value.strategyId, MaximumIdentifierBytes, 'patch strategy id')
  boundedString(value.path, MaximumPathBytes, 'patch path')
  optionalBoundedString(value.baseRevision, MaximumIdentifierBytes, 'patch base revision')
  optionalBoundedString(value.oldContent, MaximumContentBytes, 'patch old content')
  optionalBoundedString(value.newContent, MaximumContentBytes, 'patch new content')
  boundedString(value.diff, MaximumContentBytes, 'patch diff')
  if (!Number.isSafeInteger(value.changedLines) || (value.changedLines as number) < 0)
    fail('patch changed lines')
  if (!isRisk(value.risk)) fail('patch risk')
  if (!isUndefined(value.metadata) && !isRecord(value.metadata)) fail('patch metadata')
  if (isRecord(value.metadata)) assertOptionalFileMode(value.metadata.fileMode)
}

function assertOptionalFileMode(value: unknown): void {
  if (!isUndefined(value) && (!isNumber(value) || !Number.isInteger(value) || value < 0 || value > 0o777)) fail('file mode')
}

function assertFileSnapshot(value: unknown): void {
  if (!isRecord(value)) fail('base snapshot must be an object')
  boundedString(value.path, MaximumPathBytes, 'base snapshot path')
  boundedString(value.revision, MaximumIdentifierBytes, 'base snapshot revision')
  if (!isBoolean(value.exists) || !isBoolean(value.isDirectory) || !isBoolean(value.isBinary)) {
    fail('base snapshot flags')
  }
  optionalBoundedString(value.content, MaximumContentBytes, 'base snapshot content')
  assertOptionalFileMode(value.mode)
}

function assertStoredTransaction(value: unknown): asserts value is StoredTransaction {
  if (!isRecord(value)) fail('transaction must be an object')
  boundedString(value.transactionId, MaximumIdentifierBytes, 'transaction id')
  if (!['prepared', 'validated', 'applied', 'rolled_back'].includes(String(value.status)))
    fail('transaction status')
  if (!isArray(value.patches) || value.patches.length > MaximumPatchesPerTransaction)
    fail('transaction patches')
  for (const patch of value.patches) assertPatch(patch)
  assertStringArray(
    value.changedFiles,
    MaximumChangedFilesPerTransaction,
    'transaction changed files',
  )
  boundedString(value.diff, MaximumContentBytes, 'transaction diff')
  if (!Number.isSafeInteger(value.changedLines) || (value.changedLines as number) < 0)
    fail('transaction changed lines')
  if (!isRisk(value.risk)) fail('transaction risk')
  if (!isFiniteNumber(value.createdAt)) fail('transaction createdAt')
  if (!isUndefined(value.appliedAt) && !isFiniteNumber(value.appliedAt)) {
    fail('transaction appliedAt')
  }
  const hasAppliedAt = !isUndefined(value.appliedAt)
  const expectsAppliedAt = value.status === 'applied' || value.status === 'rolled_back'
  if (hasAppliedAt !== expectsAppliedAt) fail('transaction status/appliedAt mismatch')
  if (
    !isArray(value.baseSnapshots) ||
    value.baseSnapshots.length > MaximumChangedFilesPerTransaction
  ) {
    fail('transaction base snapshots')
  }
  for (const snapshot of value.baseSnapshots) assertFileSnapshot(snapshot)
}

function assertProjection(value: unknown): asserts value is ProjectChangeRecordInput {
  if (!isRecord(value)) fail('change projection must be an object')
  boundedString(value.transactionId, MaximumIdentifierBytes, 'projection transaction id')
  if (
    ![
      'prepared',
      'amended',
      'validated',
      'validation_failed',
      'applied',
      'rolled_back',
      'discarded',
    ].includes(String(value.lifecycle))
  ) {
    fail('projection lifecycle')
  }
  optionalBoundedString(value.reason, MaximumContentBytes, 'projection reason')
  if (!isArray(value.intents) || value.intents.length > MaximumPatchesPerTransaction)
    fail('projection intents')
  if (!isArray(value.patches) || value.patches.length > MaximumPatchesPerTransaction)
    fail('projection patches')
  assertStringArray(
    value.changedFiles,
    MaximumChangedFilesPerTransaction,
    'projection changed files',
  )
  boundedString(value.diff, MaximumContentBytes, 'projection diff')
  if (!Number.isSafeInteger(value.changedLines) || (value.changedLines as number) < 0)
    fail('projection changed lines')
  if (!isRisk(value.risk)) fail('projection risk')
  if (!isArray(value.revisions) || value.revisions.length > MaximumChangedFilesPerTransaction)
    fail('projection revisions')
  if (!isFiniteNumber(value.createdAt)) fail('projection createdAt')
  if (!isUndefined(value.appliedAt) && !isFiniteNumber(value.appliedAt)) {
    fail('projection appliedAt')
  }
}

function assertFileState(
  value: unknown,
  label: string,
): asserts value is ProjectTransactionFileState {
  if (!isRecord(value) || !isBoolean(value.exists)) fail(label)
  optionalBoundedString(value.content, MaximumContentBytes, label)
  assertStoredBytes(value.bytes, value.content)
  if (value.exists && !isString(value.content)) fail(label)
  if (!value.exists && (!isUndefined(value.content) || !isUndefined(value.bytes))) fail(label)
}

function assertStoredBytes(value: unknown, content: unknown): void {
  if (isUndefined(value)) return
  boundedString(value, Math.ceil(MaximumContentBytes / 3) * 4, 'raw bytes size')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || decodeProjectTextBuffer(bytes) !== content) fail('raw bytes do not match text')
}

function assertBytePlans(value: unknown, transactions: ReadonlyMap<string, StoredTransaction>): void {
  if (isUndefined(value)) return
  if (!isArray(value) || value.length > MaximumTransactions) fail('byte plans')
  const seen = new Set<string>()
  for (const plan of value) {
    if (!isRecord(plan) || !isString(plan.transactionId) || seen.has(plan.transactionId)) fail('byte plan identity')
    seen.add(plan.transactionId)
    const transaction = transactions.get(plan.transactionId)
    if (!transaction || !isArray(plan.patches) || plan.patches.length !== transaction.patches.length) fail('byte plan transaction')
    const previous = new Map<string, string | undefined>()
    for (const [index, entry] of plan.patches.entries()) {
      const patch = transaction.patches[index]!
      if (!isRecord(entry) || entry.patchId !== patch.patchId || entry.path !== patch.path) fail('byte plan patch')
      const unavailable = isTrue(entry.beforeUnavailable)
      if (!isUndefined(entry.beforeUnavailable) && !unavailable) fail('byte plan unavailable marker')
      if (unavailable && (createsMissingFile(patch) || isString(patch.oldContent) || !isUndefined(entry.before))) fail('byte plan unavailable original')
      if (!unavailable && createsMissingFile(patch) === !isUndefined(entry.before)) fail('byte plan before presence')
      if (isDeletePatch(patch) === !isUndefined(entry.after)) fail('byte plan after presence')
      if (previous.has(patch.path) && (unavailable || previous.get(patch.path) !== entry.before)) fail('byte plan chain')
      previous.set(patch.path, entry.after as string | undefined)
      assertStoredBytes(entry.before, patch.oldContent ?? '')
      assertStoredBytes(entry.after, patch.newContent ?? '')
    }
  }
}

function assertPending(value: unknown): asserts value is ProjectTransactionPendingOperation {
  if (!isRecord(value)) fail('pending operation')
  if (value.kind !== 'apply' && value.kind !== 'rollback') fail('pending operation kind')
  boundedString(value.transactionId, MaximumIdentifierBytes, 'pending transaction id')
  if (!['prepared', 'validated', 'applied', 'rolled_back'].includes(String(value.previousStatus))) {
    fail('pending previous status')
  }
  if (!isArray(value.restore) || value.restore.length > MaximumChangedFilesPerTransaction)
    fail('pending restore plan')
  const restorePaths = new Set<string>()
  for (const entry of value.restore) {
    assertFileState(entry, 'pending restore entry')
    assertOptionalFileMode((entry as { mode?: unknown }).mode)
    const encoding = (entry as { encoding?: unknown }).encoding
    if (!isUndefined(encoding) && !isProjectTextEncoding(encoding)) fail('pending restore encoding')
    const pathValue = (entry as { path?: unknown }).path
    boundedString(pathValue, MaximumPathBytes, 'pending restore path')
    if (restorePaths.has(pathValue)) fail('duplicate pending restore path')
    restorePaths.add(pathValue)
    const ownedStates = (entry as { ownedStates?: unknown }).ownedStates
    if (
      !isArray(ownedStates) ||
      ownedStates.length === 0 ||
      ownedStates.length > MaximumPatchesPerTransaction
    ) {
      fail('pending owned states')
    }
    for (const state of ownedStates) assertFileState(state, 'pending owned state')
  }
}

function assertSnapshot(
  value: unknown,
  root: string,
): asserts value is ProjectTransactionStateSnapshot {
  if (!isRecord(value)) fail('root object')
  if (value.formatVersion !== 1 && value.formatVersion !== StateFormatVersion) fail('format version')
  if (value.formatVersion === 1 && !isUndefined(value.bytePlans)) fail('byte plans require state version 2')
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) fail('revision')
  if (value.root !== root) fail('project root mismatch')
  if (!isArray(value.transactions) || value.transactions.length > MaximumTransactions)
    fail('transactions')
  const transactionsById = new Map<string, StoredTransaction>()
  for (const transaction of value.transactions) {
    assertStoredTransaction(transaction)
    if (transactionsById.has(transaction.transactionId)) fail('duplicate transaction id')
    transactionsById.set(transaction.transactionId, transaction)
  }
  assertBytePlans(value.bytePlans, transactionsById)
  if (!isArray(value.projections) || value.projections.length > MaximumTransactions)
    fail('projections')
  const projectionIds = new Set<string>()
  for (const projection of value.projections) {
    assertProjection(projection)
    if (projectionIds.has(projection.transactionId)) fail('duplicate projection transaction id')
    projectionIds.add(projection.transactionId)
  }
  const pending = value.pending
  if (!isUndefined(pending)) assertPending(pending)

  if (pending) {
    const transaction = transactionsById.get(pending.transactionId)
    if (!transaction) fail('pending transaction is missing')
    if (transaction.status !== pending.previousStatus) fail('pending transaction status mismatch')
    const changedFiles = new Set(transaction.changedFiles)
    if (
      pending.restore.length !== changedFiles.size ||
      pending.restore.some((entry) => !changedFiles.has(entry.path))
    ) {
      fail('pending restore paths do not match transaction')
    }
  }
}

function cloneSnapshot(value: ProjectTransactionStateSnapshot): ProjectTransactionStateSnapshot {
  return JSON.parse(JSON.stringify(value)) as ProjectTransactionStateSnapshot
}

/**
 * One host-owned, atomically replaced transaction snapshot. Project files and
 * this snapshot are not one filesystem transaction; `pending.restore` is the
 * durable write-ahead boundary that makes an interrupted apply/rollback
 * recoverable on the next owner start.
 */
export class FileProjectTransactionStateStore {
  public readonly path: string
  public readonly root: string
  private current: ProjectTransactionStateSnapshot

  public constructor(options: FileProjectTransactionStateStoreOptions) {
    this.path = resolve(options.path)
    this.root = resolve(options.root)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    this.current = this.load()
  }

  private empty(): ProjectTransactionStateSnapshot {
    return {
      formatVersion: StateFormatVersion,
      revision: 0,
      root: this.root,
      transactions: [],
      projections: [],
    }
  }

  private load(): ProjectTransactionStateSnapshot {
    if (!existsSync(this.path)) return this.empty()
    const metadata = lstatSync(this.path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail('state path must be a regular file')
    if (statSync(this.path).size > MaximumStateBytes) fail('state file exceeds 256 MiB')
    const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
    assertSnapshot(parsed, this.root)
    return cloneSnapshot(parsed)
  }

  public snapshot(): ProjectTransactionStateSnapshot {
    return cloneSnapshot(this.current)
  }

  public commit(input: {
    readonly transactions: readonly StoredTransaction[]
    readonly projections: readonly ProjectChangeRecordInput[]
    readonly pending?: ProjectTransactionPendingOperation
    readonly bytePlans?: readonly TransactionBytePlan[]
  }): ProjectTransactionStateSnapshot {
    const next: ProjectTransactionStateSnapshot = {
      formatVersion: StateFormatVersion,
      revision: this.current.revision + 1,
      root: this.root,
      transactions: input.transactions,
      projections: input.projections,
      pending: toOptional(input.pending),
      bytePlans: input.bytePlans,
    }
    const source = JSON.stringify(next)
    if (new TextEncoder().encode(source).byteLength > MaximumStateBytes)
      fail('state file exceeds 256 MiB')
    const parsed: unknown = JSON.parse(source)
    assertSnapshot(parsed, this.root)
    this.writeAtomic(source)
    this.current = cloneSnapshot(parsed)
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
        0o600,
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
