/**
 * 事务状态文件的格式与校验：读回和写入前逐项核对整份状态，任何一项不合规就按状态文件损坏拒绝，不带病加载。
 * 各项的防护上限在 `ProjectTuning.persistence`；抛出的失败说明后面接的是哪一项没过（英文标记，也放进 details.stateValidationFailure）。
 */

import { isArray, isBoolean, isFiniteNumber, isNumber, isRecord, isString, isTrue, isUndefined } from '@velaros-ai/core'

import type { ProjectChangeRecordInput } from '../../types/change-feed.js'
import type { ProjectTransactionFileState, ProjectTransactionPendingOperation, ProjectTransactionStateSnapshot, StoredTransaction } from '../../types/transaction.js'
import { ProjectError } from '../errors.js'
import { decodeProjectTextBuffer, isProjectTextEncoding } from '../text.js'
import { ProjectTuning } from '../tuning.js'

import { isDeletePatch } from './patch-chain.js'
import { createsMissingFile } from './patch-ownership.js'

/** 事务状态文件的格式版本：legacy 是没有字节计划的旧格式，只读不写；current 是现在写出的格式。 */
export const TransactionStateFormatVersions = Object.freeze({
  legacy: 1,
  current: 2,
} as const)

/** 按事务状态文件损坏抛 TRANSACTION_RECOVERY_CONFLICT：message 是哪一项没通过（同时放进 details.stateValidationFailure），建议先保全两侧再人工恢复。 */
export function invalidTransactionState(message: string): never {
  throw new ProjectError(
    'TRANSACTION_RECOVERY_CONFLICT',
    `事务状态文件无效：${message}`,
    { stateValidationFailure: message },
    '请保全事务状态文件和项目目录，不要删除或重写任一侧；先确认损坏来源再人工恢复。',
  )
}

/** 状态文件（或将要写入的内容）的字节数超过 ProjectTuning.persistence.stateFileBytes 就按损坏拒绝。 */
export function assertTransactionStateSize(bytes: number): void {
  const maximum = ProjectTuning.persistence.stateFileBytes
  if (bytes > maximum) invalidTransactionState(`state file exceeds ${maximum / 1024 / 1024} MiB`)
}

/** 核对是字符串且 UTF-8 字节数不超过 maximum，否则按 label 判损坏。 */
function boundedString(value: unknown, maximum: number, label: string): asserts value is string {
  if (!isString(value) || new TextEncoder().encode(value).byteLength > maximum) invalidTransactionState(label)
}

/** 可以缺席；在的话同 boundedString。 */
function optionalBoundedString(value: unknown, maximum: number, label: string): void {
  if (!isUndefined(value)) boundedString(value, maximum, label)
}

/** 是不是 low、medium、high 三档风险之一。 */
function isRisk(value: unknown): boolean {
  return value === 'low' || value === 'medium' || value === 'high'
}

/** 核对是不超过 maximum 项的数组，每一项都是不超长的路径字符串。 */
function assertStringArray(
  value: unknown,
  maximum: number,
  label: string,
): asserts value is string[] {
  if (!isArray(value) || value.length > maximum) invalidTransactionState(label)
  for (const item of value) boundedString(item, ProjectTuning.persistence.statePathBytes, label)
}

/** 核对一个落盘的补丁：各标识、路径、正文与差量都不超长，改动行数是非负整数，风险合法，metadata 是对象且权限位合法。 */
function assertPatch(value: unknown): void {
  if (!isRecord(value)) invalidTransactionState('patch must be an object')
  boundedString(value.patchId, ProjectTuning.persistence.stateIdentifierBytes, 'patch id')
  boundedString(value.strategyId, ProjectTuning.persistence.stateIdentifierBytes, 'patch strategy id')
  boundedString(value.path, ProjectTuning.persistence.statePathBytes, 'patch path')
  optionalBoundedString(value.baseRevision, ProjectTuning.persistence.stateIdentifierBytes, 'patch base revision')
  optionalBoundedString(value.oldContent, ProjectTuning.persistence.stateContentBytes, 'patch old content')
  optionalBoundedString(value.newContent, ProjectTuning.persistence.stateContentBytes, 'patch new content')
  boundedString(value.diff, ProjectTuning.persistence.stateContentBytes, 'patch diff')
  if (!Number.isSafeInteger(value.changedLines) || (value.changedLines as number) < 0)
    invalidTransactionState('patch changed lines')
  if (!isRisk(value.risk)) invalidTransactionState('patch risk')
  if (!isUndefined(value.metadata) && !isRecord(value.metadata)) invalidTransactionState('patch metadata')
  if (isRecord(value.metadata)) assertOptionalFileMode(value.metadata.fileMode)
}

/** 文件权限可以缺席；在的话必须是 0 到 0o777 之间的整数。 */
function assertOptionalFileMode(value: unknown): void {
  if (!isUndefined(value) && (!isNumber(value) || !Number.isInteger(value) || value < 0 || value > 0o777)) invalidTransactionState('file mode')
}

/** 核对一份落盘的基准快照：路径、revision、三个布尔标记、正文与权限位。 */
function assertFileSnapshot(value: unknown): void {
  if (!isRecord(value)) invalidTransactionState('base snapshot must be an object')
  boundedString(value.path, ProjectTuning.persistence.statePathBytes, 'base snapshot path')
  boundedString(value.revision, ProjectTuning.persistence.stateIdentifierBytes, 'base snapshot revision')
  if (!isBoolean(value.exists) || !isBoolean(value.isDirectory) || !isBoolean(value.isBinary)) {
    invalidTransactionState('base snapshot flags')
  }
  optionalBoundedString(value.content, ProjectTuning.persistence.stateContentBytes, 'base snapshot content')
  assertOptionalFileMode(value.mode)
}

/** 核对一个落盘的事务：事务号、稳定状态、补丁、改动文件、差量、行数、风险与时间戳，状态与 appliedAt 一致，基准快照合法。 */
function assertStoredTransaction(value: unknown): asserts value is StoredTransaction {
  if (!isRecord(value)) invalidTransactionState('transaction must be an object')
  boundedString(value.transactionId, ProjectTuning.persistence.stateIdentifierBytes, 'transaction id')
  if (!['prepared', 'validated', 'applied', 'rolled_back'].includes(String(value.status)))
    invalidTransactionState('transaction status')
  if (!isArray(value.patches) || value.patches.length > ProjectTuning.persistence.statePatchesPerTransaction)
    invalidTransactionState('transaction patches')
  for (const patch of value.patches) assertPatch(patch)
  assertStringArray(
    value.changedFiles,
    ProjectTuning.persistence.stateChangedFilesPerTransaction,
    'transaction changed files',
  )
  boundedString(value.diff, ProjectTuning.persistence.stateContentBytes, 'transaction diff')
  if (!Number.isSafeInteger(value.changedLines) || (value.changedLines as number) < 0)
    invalidTransactionState('transaction changed lines')
  if (!isRisk(value.risk)) invalidTransactionState('transaction risk')
  if (!isFiniteNumber(value.createdAt)) invalidTransactionState('transaction createdAt')
  if (!isUndefined(value.appliedAt) && !isFiniteNumber(value.appliedAt)) {
    invalidTransactionState('transaction appliedAt')
  }
  const hasAppliedAt = !isUndefined(value.appliedAt)
  const expectsAppliedAt = value.status === 'applied' || value.status === 'rolled_back'
  if (hasAppliedAt !== expectsAppliedAt) invalidTransactionState('transaction status/appliedAt mismatch')
  if (
    !isArray(value.baseSnapshots) ||
    value.baseSnapshots.length > ProjectTuning.persistence.stateChangedFilesPerTransaction
  ) {
    invalidTransactionState('transaction base snapshots')
  }
  for (const snapshot of value.baseSnapshots) assertFileSnapshot(snapshot)
}

/** 核对一条落盘的变更投影：事务号、生命周期、原因、意图、补丁、改动文件、差量、行数、风险、版本记录与时间戳。 */
function assertProjection(value: unknown): asserts value is ProjectChangeRecordInput {
  if (!isRecord(value)) invalidTransactionState('change projection must be an object')
  boundedString(value.transactionId, ProjectTuning.persistence.stateIdentifierBytes, 'projection transaction id')
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
    invalidTransactionState('projection lifecycle')
  }
  optionalBoundedString(value.reason, ProjectTuning.persistence.stateContentBytes, 'projection reason')
  if (!isArray(value.intents) || value.intents.length > ProjectTuning.persistence.statePatchesPerTransaction)
    invalidTransactionState('projection intents')
  if (!isArray(value.patches) || value.patches.length > ProjectTuning.persistence.statePatchesPerTransaction)
    invalidTransactionState('projection patches')
  assertStringArray(
    value.changedFiles,
    ProjectTuning.persistence.stateChangedFilesPerTransaction,
    'projection changed files',
  )
  boundedString(value.diff, ProjectTuning.persistence.stateContentBytes, 'projection diff')
  if (!Number.isSafeInteger(value.changedLines) || (value.changedLines as number) < 0)
    invalidTransactionState('projection changed lines')
  if (!isRisk(value.risk)) invalidTransactionState('projection risk')
  if (!isArray(value.revisions) || value.revisions.length > ProjectTuning.persistence.stateChangedFilesPerTransaction)
    invalidTransactionState('projection revisions')
  if (!isFiniteNumber(value.createdAt)) invalidTransactionState('projection createdAt')
  if (!isUndefined(value.appliedAt) && !isFiniteNumber(value.appliedAt)) {
    invalidTransactionState('projection appliedAt')
  }
}

/** 核对恢复计划里的一个文件状态：存在的必须带正文，不存在的不能带正文或原字节；原字节要能无损解码成正文。 */
function assertFileState(
  value: unknown,
  label: string,
): asserts value is ProjectTransactionFileState {
  if (!isRecord(value) || !isBoolean(value.exists)) invalidTransactionState(label)
  optionalBoundedString(value.content, ProjectTuning.persistence.stateContentBytes, label)
  assertStoredBytes(value.bytes, value.content)
  if (value.exists && !isString(value.content)) invalidTransactionState(label)
  if (!value.exists && (!isUndefined(value.content) || !isUndefined(value.bytes))) invalidTransactionState(label)
}

/** 原字节（base64）可以缺席；在的话必须是规范的 base64、不超上限，并且解码后正好是给定正文。 */
function assertStoredBytes(value: unknown, content: unknown): void {
  if (isUndefined(value)) return
  boundedString(value, Math.ceil(ProjectTuning.persistence.stateContentBytes / 3) * 4, 'raw bytes size')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || decodeProjectTextBuffer(bytes) !== content) invalidTransactionState('raw bytes do not match text')
}

/**
 * 核对字节计划：每个计划对应一个已存在的事务、补丁逐个对上；写前字节在不在与补丁是不是新建一致，写后字节在不在与补丁是不是删除一致，
 * 原字节取不到的标记只能出现在既有文件上，同一路径前后补丁的字节首尾相接。
 */
function assertBytePlans(value: unknown, transactions: ReadonlyMap<string, StoredTransaction>): void {
  if (isUndefined(value)) return
  if (!isArray(value) || value.length > ProjectTuning.persistence.stateTransactions) invalidTransactionState('byte plans')
  const seen = new Set<string>()
  for (const plan of value) {
    if (!isRecord(plan) || !isString(plan.transactionId) || seen.has(plan.transactionId)) invalidTransactionState('byte plan identity')
    seen.add(plan.transactionId)
    const transaction = transactions.get(plan.transactionId)
    if (!transaction || !isArray(plan.patches) || plan.patches.length !== transaction.patches.length) invalidTransactionState('byte plan transaction')
    const previous = new Map<string, string | undefined>()
    for (const [index, entry] of plan.patches.entries()) {
      const patch = transaction.patches[index]!
      if (!isRecord(entry) || entry.patchId !== patch.patchId || entry.path !== patch.path) invalidTransactionState('byte plan patch')
      const unavailable = isTrue(entry.beforeUnavailable)
      if (!isUndefined(entry.beforeUnavailable) && !unavailable) invalidTransactionState('byte plan unavailable marker')
      if (unavailable && (createsMissingFile(patch) || isString(patch.oldContent) || !isUndefined(entry.before))) invalidTransactionState('byte plan unavailable original')
      if (!unavailable && createsMissingFile(patch) === !isUndefined(entry.before)) invalidTransactionState('byte plan before presence')
      if (isDeletePatch(patch) === !isUndefined(entry.after)) invalidTransactionState('byte plan after presence')
      if (previous.has(patch.path) && (unavailable || previous.get(patch.path) !== entry.before)) invalidTransactionState('byte plan chain')
      previous.set(patch.path, entry.after as string | undefined)
      assertStoredBytes(entry.before, patch.oldContent ?? '')
      assertStoredBytes(entry.after, patch.newContent ?? '')
    }
  }
}

/** 核对落盘的未完成操作（apply 或 rollback 的恢复点）：种类、事务号、之前的状态，恢复计划里每个路径只出现一次且各自带至少一个本事务留下的状态。 */
function assertPending(value: unknown): asserts value is ProjectTransactionPendingOperation {
  if (!isRecord(value)) invalidTransactionState('pending operation')
  if (value.kind !== 'apply' && value.kind !== 'rollback') invalidTransactionState('pending operation kind')
  boundedString(value.transactionId, ProjectTuning.persistence.stateIdentifierBytes, 'pending transaction id')
  if (!['prepared', 'validated', 'applied', 'rolled_back'].includes(String(value.previousStatus))) {
    invalidTransactionState('pending previous status')
  }
  if (!isArray(value.restore) || value.restore.length > ProjectTuning.persistence.stateChangedFilesPerTransaction)
    invalidTransactionState('pending restore plan')
  const restorePaths = new Set<string>()
  for (const entry of value.restore) {
    assertFileState(entry, 'pending restore entry')
    assertOptionalFileMode((entry as { mode?: unknown }).mode)
    const encoding = (entry as { encoding?: unknown }).encoding
    if (!isUndefined(encoding) && !isProjectTextEncoding(encoding)) invalidTransactionState('pending restore encoding')
    const pathValue = (entry as { path?: unknown }).path
    boundedString(pathValue, ProjectTuning.persistence.statePathBytes, 'pending restore path')
    if (restorePaths.has(pathValue)) invalidTransactionState('duplicate pending restore path')
    restorePaths.add(pathValue)
    const ownedStates = (entry as { ownedStates?: unknown }).ownedStates
    if (
      !isArray(ownedStates) ||
      ownedStates.length === 0 ||
      ownedStates.length > ProjectTuning.persistence.statePatchesPerTransaction
    ) {
      invalidTransactionState('pending owned states')
    }
    for (const state of ownedStates) assertFileState(state, 'pending owned state')
  }
}

/**
 * 核对整份事务状态：格式版本、revision、项目根一致，事务与投影各自合法且事务号不重复，字节计划合法，
 * 未完成操作指向的事务存在、状态对得上、恢复路径正好是它的改动文件；任何一项不过都按状态文件损坏抛出。
 */
export function assertTransactionStateSnapshot(
  value: unknown,
  root: string,
): asserts value is ProjectTransactionStateSnapshot {
  if (!isRecord(value)) invalidTransactionState('root object')
  if (value.formatVersion !== TransactionStateFormatVersions.legacy && value.formatVersion !== TransactionStateFormatVersions.current) invalidTransactionState('format version')
  if (value.formatVersion === TransactionStateFormatVersions.legacy && !isUndefined(value.bytePlans)) invalidTransactionState('byte plans require state version 2')
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) invalidTransactionState('revision')
  if (value.root !== root) invalidTransactionState('project root mismatch')
  if (!isArray(value.transactions) || value.transactions.length > ProjectTuning.persistence.stateTransactions)
    invalidTransactionState('transactions')
  const transactionsById = new Map<string, StoredTransaction>()
  for (const transaction of value.transactions) {
    assertStoredTransaction(transaction)
    if (transactionsById.has(transaction.transactionId)) invalidTransactionState('duplicate transaction id')
    transactionsById.set(transaction.transactionId, transaction)
  }
  assertBytePlans(value.bytePlans, transactionsById)
  if (!isArray(value.projections) || value.projections.length > ProjectTuning.persistence.stateTransactions)
    invalidTransactionState('projections')
  const projectionIds = new Set<string>()
  for (const projection of value.projections) {
    assertProjection(projection)
    if (projectionIds.has(projection.transactionId)) invalidTransactionState('duplicate projection transaction id')
    projectionIds.add(projection.transactionId)
  }
  const pending = value.pending
  if (!isUndefined(pending)) assertPending(pending)

  if (pending) {
    const transaction = transactionsById.get(pending.transactionId)
    if (!transaction) invalidTransactionState('pending transaction is missing')
    if (transaction.status !== pending.previousStatus) invalidTransactionState('pending transaction status mismatch')
    const changedFiles = new Set(transaction.changedFiles)
    if (
      pending.restore.length !== changedFiles.size ||
      pending.restore.some((entry) => !changedFiles.has(entry.path))
    ) {
      invalidTransactionState('pending restore paths do not match transaction')
    }
  }
}

/** 深拷贝一份事务状态（JSON 往返）：进出状态文件都复制，外面改不到里面存的那份。 */
export function cloneTransactionState(value: ProjectTransactionStateSnapshot): ProjectTransactionStateSnapshot {
  return JSON.parse(JSON.stringify(value)) as ProjectTransactionStateSnapshot
}
