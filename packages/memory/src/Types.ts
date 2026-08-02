import type BetterSqlite3 from 'better-sqlite3'

import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
} from '@velaros-ai/core/tool-contract'

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

export interface MemoryApi {
  captureEvidence: (
    input: MemoryEvidenceInput
  ) => Promise<MemoryCaptureResult> | MemoryCaptureResult
  recall: (
    query: string,
    options?: MemoryRecallOptions
  ) => Promise<MemoryRecallItem[]> | MemoryRecallItem[]
  getClaim: (
    claimId: string
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
  forgetClaim: (
    claimId: string
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
