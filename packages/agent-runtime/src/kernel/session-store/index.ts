// 门面：SessionStore 树形账本引擎子域（宪章 §2 Ring1 / §6 会话树 entry 类型学）。经 kernel/index 挂出。
export {
  canonicalJsonStringify,
  LEDGER_LINE_SEPARATOR,
  type LedgerReadResult,
  parseLedgerText,
  readLedgerFile,
  serializeLedgerLine,
  truncateLedgerToEntryCount,
} from './ledger-file'
export type {
  SessionEntryDraft,
  SessionLedgerLocator,
  SessionLedgerWarn,
  SessionStoreDeps,
} from './ports'
export {
  buildContextEntries,
  buildSessionTree,
  classifySessionEntry,
  isProviderContextEntry,
  isSnapshotComparableEntry,
  pathRootToLeaf,
  resolveCurrentLeafId,
  type SessionEntryClass,
  type SessionTree,
  type SessionTreeNode,
} from './session-tree'
export { SessionLedger, SessionStore } from './SessionLedger'
export { SerialWriteQueue } from './write-queue'
