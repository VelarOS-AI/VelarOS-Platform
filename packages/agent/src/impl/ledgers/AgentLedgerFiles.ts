// 落盘账本文件的读取与规范化：宿主做迁移、诊断与备份时经这件能力读，不各写一份解析。
import type { ExecutionSpan, SessionEntry } from '../../types/agent'
import type { ExecutionSpanDebugProjection, LedgerReadResult, ProjectExecutionSpanDebugOptions, SpanLedgerReadResult } from '../../types/ledgers'
import { readSpanLedgerFile } from '../../utils/ledgers/execution-ledger-file'
import { projectExecutionSpanDebug } from '../../utils/ledgers/execution-span-debug'
import { completeLineByteLength } from '../../utils/ledgers/jsonl-file'
import { canonicalJsonStringify, readLedgerFile, truncateLedgerToEntryCount } from '../../utils/ledgers/ledger-file'
import { isSnapshotComparableEntry } from '../../utils/ledgers/session-tree'

/**
 * Agent 落盘账本文件的读取面：会话树账本、span 账本、提示词审计各有自己的行格式，
 * 这里把「怎么读、怎么容忍半截尾行、怎么按条数截断」收在一处。
 *
 * 只读与截断两类动作，无状态；真正的写入由各自的账本类负责。
 */
export interface AgentLedgerFilesApi {
  /** 读一份账本文件，半截的尾行按容忍规则丢掉。 */
  readLedgerFile(path: string): Promise<LedgerReadResult>
  /** 把账本文件截断到指定条数（回滚与压缩用）。 */
  truncateLedgerToEntryCount(path: string, entryCount: number): Promise<boolean>
  /** 键序稳定的 JSON 序列化：同内容必同字节，账本行与指纹都靠它。 */
  canonicalJsonStringify(value: unknown): string
  /** 算一段 JSONL 文本里完整行占的字节数（尾部半截行不计）。 */
  completeLineByteLength(buffer: Buffer, lineCount: number): Nullable<number>
  /** 读一份执行 span 账本文件。 */
  readSpanLedgerFile(path: string): Promise<SpanLedgerReadResult>
  /** 把 span 账本投影成调试面板看的树。 */
  projectExecutionSpanDebug(spans: readonly ExecutionSpan[], options?: ProjectExecutionSpanDebugOptions): ExecutionSpanDebugProjection
  /** 判断一条会话树记录能不能参与快照比对。 */
  isSnapshotComparableEntry(entry: SessionEntry): boolean
}

/** 方法逐个转调 utils/ledgers 里的纯函数；这里只负责把它们收成一件对外能力。 */
class AgentLedgerFiles implements AgentLedgerFilesApi {
  public readLedgerFile(path: string): Promise<LedgerReadResult> {
    return readLedgerFile(path)
  }

  public truncateLedgerToEntryCount(path: string, entryCount: number): Promise<boolean> {
    return truncateLedgerToEntryCount(path, entryCount)
  }

  public canonicalJsonStringify(value: unknown): string {
    return canonicalJsonStringify(value)
  }

  public completeLineByteLength(buffer: Buffer, lineCount: number): Nullable<number> {
    return completeLineByteLength(buffer, lineCount)
  }

  public readSpanLedgerFile(path: string): Promise<SpanLedgerReadResult> {
    return readSpanLedgerFile(path)
  }

  public projectExecutionSpanDebug(spans: readonly ExecutionSpan[], options?: ProjectExecutionSpanDebugOptions): ExecutionSpanDebugProjection {
    return projectExecutionSpanDebug(spans, options)
  }

  public isSnapshotComparableEntry(entry: SessionEntry): boolean {
    return isSnapshotComparableEntry(entry)
  }
}

/** 账本文件读取面（无状态，进程内共用一份）。 */
export const agentLedgerFiles: AgentLedgerFilesApi = new AgentLedgerFiles()
