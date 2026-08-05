import type BetterSqlite3 from 'better-sqlite3'

import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
} from '@velaros-ai/agent/tool-contract'

import type { MemoryBackendVerb } from './backend/Contract'
import type {
  MemoryCaptureResult,
  MemoryDreamRunOptions,
  MemoryDreamRunResult,
  MemoryEvidenceEligibilityResult,
  MemoryEvidenceEligibilityState,
  MemoryEvidenceInput,
  MemoryForgetResult,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemorySourceEligibilityResult,
  MemoryTreeDiagnostics,
  MemoryTreeIntegrityReport,
  MemoryTreeState,
} from './memory-tree/Types'
import type { MemoryScopeId } from './MemoryScope'

type SQLiteDatabase = InstanceType<typeof BetterSqlite3>

/** 宿主已打开的 SQLite 连接解析端口。 */
export type MemoryDatabaseProvider = () => SQLiteDatabase

/** 记忆树运行时只依赖数据库；不携带 Knowledge 的 embedding 配置。 */
export interface MemoryTreeRuntimeProviders {
  databaseProvider: MemoryDatabaseProvider
}

/**
 * 工具面看得见的后端自述。
 *
 * 工具契约必须后端无关（不讲 Evidence→Dream→Claim 管线），但**返回值**可以按能力分档：
 * 装了整理管线才说「稍后整理」，有版本概念才回版本号。没有这一格，工具只能二选一
 * ——要么对所有后端说树档的话（默认形态下是假的），要么对所有后端只说最小公倍数。
 */
export interface MemoryBackendCapabilities {
  id: string
  verbs: readonly MemoryBackendVerb[]
}

export interface MemoryApi {
  /** 当前记忆后端是谁、支持哪些动词。工具据此分档措辞与返回字段，不做 `instanceof` 探测。 */
  describeBackend: () => MemoryBackendCapabilities
  captureEvidence: (
    input: MemoryEvidenceInput
  ) => Promise<MemoryCaptureResult> | MemoryCaptureResult
  recall: (
    query: string,
    options?: MemoryRecallOptions
  ) => Promise<MemoryRecallItem[]> | MemoryRecallItem[]
  /** 按 `recall` 返回的 id 读单条记忆。命名不带 Claim：树档之外没有 Claim 这个概念。 */
  getMemory: (
    memoryId: string
  ) => Promise<Nullable<MemoryRecallItem>> | Nullable<MemoryRecallItem>
  getTreeState: () => Promise<MemoryTreeState> | MemoryTreeState
  getTreeStateAtVersion: (
    version: number
  ) => Promise<MemoryTreeState> | MemoryTreeState
  verifyTreeIntegrity: (
  ) => Promise<MemoryTreeIntegrityReport> | MemoryTreeIntegrityReport
  getDiagnostics: (
  ) => Promise<MemoryTreeDiagnostics> | MemoryTreeDiagnostics
  runDream: (
    options: MemoryDreamRunOptions
  ) => Promise<MemoryDreamRunResult> | MemoryDreamRunResult
  /** 归档一条记忆：退出普通召回，内容不删（窄端口 `archive` 动词，后端可缺席）。 */
  archiveMemory: (
    memoryId: string
  ) => Promise<MemoryForgetResult> | MemoryForgetResult
  setEvidenceEligibility: (
    evidenceId: string,
    state: MemoryEvidenceEligibilityState
  ) => Promise<MemoryEvidenceEligibilityResult> | MemoryEvidenceEligibilityResult
  setSessionEvidenceEligibility: (
    sessionId: string,
    state: MemoryEvidenceEligibilityState
  ) => Promise<MemorySourceEligibilityResult> | MemorySourceEligibilityResult
}

/** Host-owned conversation lineage normalized at the Memory tool boundary. */
export interface MemorySessionLineageContext {
  sessionId: string
  activeBranchId?: LooseOptional<string>
  visibleBranchIds?: string[]
  excludedMessageIds?: string[]
}

export interface MemoryToolContext {
  abortSignal: AbortSignal
  sessionId: string
  memoryScope?: LooseOptional<MemoryScopeId>
  sessionLineage?: LooseOptional<MemorySessionLineageContext>
  memory: MemoryApi
}

export type ToolContext = MemoryToolContext

export type VelaTool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> = ToolContractRuntimeSpec<
  TInput,
  MemoryToolContext,
  unknown,
  string
>

export type DefineMemoryToolInput<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> = DefineToolRuntimeSpecInput<
  TInput,
  MemoryToolContext,
  unknown,
  string
> & {
  category: 'memory'
}

export function defineMemoryTool<
  TInput extends Record<string, unknown>,
>(
  input: DefineMemoryToolInput<TInput>
): VelaTool<TInput> {
  return defineToolRuntimeSpec(input)
}
