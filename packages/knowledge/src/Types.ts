import type { Connection as LanceDbConnection } from '@lancedb/lancedb'
import type BetterSqlite3 from 'better-sqlite3'

import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
} from '@velaros-ai/agent/tool-contract'

import type {
  KnowledgeDiagnostics,
  KnowledgeEmbeddingProviderId,
  KnowledgeReindexOptions,
  KnowledgeReindexResult,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeWorkspaceSyncOptions,
  KnowledgeWorkspaceSyncResult,
} from './knowledge/domain/Types'

type SQLiteDatabase = InstanceType<typeof BetterSqlite3>

export type KnowledgeDatabaseProvider = () => SQLiteDatabase

export interface KnowledgeStoragePathProvider {
  getLanceDatabasePath: () => string
}

/**
 * LanceDB 增强插件注入的最小模块端口。
 * `@velaros-ai/memory` 只在真正需要向量读写时调用它；宿主未安装插件时省略该端口，知识库仍保留
 * SQLite/FTS 文本检索与工作区摄入，不会因为原生库缺席而阻断启动。
 */
type LanceDbPackage = typeof import('@lancedb/lancedb')

export interface KnowledgeLanceDbConnection {
  tableNames: () => ReturnType<LanceDbConnection['tableNames']>
  openTable: (name: string) => ReturnType<LanceDbConnection['openTable']>
  createTable: (
    name: string,
    data: Parameters<LanceDbConnection['createTable']>[1]
  ) => ReturnType<LanceDbConnection['createTable']>
  close: () => void
}

export interface KnowledgeLanceDbModule {
  connect: (path: string) => Promise<KnowledgeLanceDbConnection>
  Index: Pick<LanceDbPackage['Index'], 'btree' | 'bitmap' | 'ivfFlat'>
}
export type KnowledgeLanceDbLoader = () => Promise<KnowledgeLanceDbModule>

export interface KnowledgeEmbeddingRuntime {
  /** Opaque provider identity. Knowledge does not know a model catalog. */
  provider: KnowledgeEmbeddingProviderId
  model: string
  apiKey: string
  baseURL: string
  /** Host-resolved availability; false produces a validation error before IO. */
  configured: boolean
  /** Optional human-readable label for configuration errors. */
  providerLabel?: string
}

/**
 * Embedding selection and provider availability are model-host concerns.
 * Knowledge consumes one already-resolved runtime and never imports a model
 * catalog, provider manifest, or environment-variable convention.
 */
export interface KnowledgeEmbeddingConfigPort {
  resolveEmbeddingRuntime: () => KnowledgeEmbeddingRuntime
  isManualEmbeddingAllowed?: () => boolean
  isAnswerEmbeddingAllowed?: () => boolean
}

export interface KnowledgeHttpClient {
  postJson: <TResponse>(
    url: string,
    options?: {
      headers?: Record<string, string>
      body?: unknown
      timeoutMs?: number
      errorContext?: string
    }
  ) => Promise<TResponse>
}

export interface EmbeddingRequest {
  url: string
  headers: Record<string, string>
  body?: unknown
  execute?: () => Promise<unknown>
}

export interface EmbeddingRequestConfig {
  provider: KnowledgeEmbeddingProviderId
  apiKey: string
  baseURL: string
}

export interface EmbeddingRequestFactory {
  createEmbeddingRequest: (
    config: EmbeddingRequestConfig,
    model: string,
    texts: string[]
  ) => EmbeddingRequest
}

export type KnowledgeCodeNodeKind =
  | 'file'
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'property'
  | 'route'
  | 'module'
  | 'other'

export type KnowledgeCodeSymbolKind =
  | 'class'
  | 'enum'
  | 'export'
  | 'function'
  | 'interface'
  | 'type'
  | 'variable'

export interface KnowledgeCodeSymbol {
  path: string
  name: string
  kind: KnowledgeCodeSymbolKind
  line: number
  column: number
  exported: boolean
}

export interface KnowledgeCodeRange {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface KnowledgeCodeNode {
  id: string
  kind: KnowledgeCodeNodeKind
  name: string
  qualifiedName: string
  filePath: string
  language: string
  range: KnowledgeCodeRange
  signature?: LooseOptional<string>
  isExported: boolean
  backendMetadata?: Record<string, unknown>
}

export interface KnowledgeCodeEdge {
  id: string
  kind: string
  fromNodeId: string
  toNodeId: string
  backendMetadata?: Record<string, unknown>
}

export interface KnowledgeCodeSubgraph {
  nodes: KnowledgeCodeNode[]
  edges: KnowledgeCodeEdge[]
  truncated?: boolean
}

export interface KnowledgeCodeSearchResult {
  node: KnowledgeCodeNode
  score: number
}

export interface KnowledgeCodeNodeSearchRequest {
  projectRoot: string
  query: string
  kind?: KnowledgeCodeNodeKind
  limit?: number
}

export interface KnowledgeCodeFileNodeRequest {
  projectRoot: string
  path: string
}

export interface KnowledgeCodeRelevantContextRequest {
  projectRoot: string
  query: string
  maxNodes?: number
}

export interface KnowledgeCodeNodeRequest {
  projectRoot: string
  nodeId: string
}

/** 由宿主注入的代码智能 API；Knowledge 不依赖 Workspace 或 Desktop。 */
export interface KnowledgeCodeIntelligenceApi {
  readonly available: boolean
  isProjectEnabled: (projectRoot: string) => boolean
  searchNodes: (
    input: KnowledgeCodeNodeSearchRequest
  ) => Promise<KnowledgeCodeSearchResult[]>
  getNodesInFile: (
    input: KnowledgeCodeFileNodeRequest
  ) => Promise<KnowledgeCodeNode[]>
  findRelevantContext: (
    input: KnowledgeCodeRelevantContextRequest
  ) => Promise<KnowledgeCodeSubgraph>
  getCodeForNode: (
    input: KnowledgeCodeNodeRequest
  ) => Promise<Nullable<string>>
}

export interface KnowledgeIndexingPolicy {
  /**
   * Return false to hide an entry from indexing. The host can inject its
   * Workspace visibility policy; the default policy only blocks conventional
   * dependency, VCS, cache, and hidden-system entries.
   */
  shouldIncludeEntry?: (input: {
    name: string
    isDirectory: boolean
    relativePath: string
  }) => boolean
}

export interface KnowledgeRuntimeProviders {
  embeddingConfig: KnowledgeEmbeddingConfigPort
  httpClient: KnowledgeHttpClient
  databaseProvider: KnowledgeDatabaseProvider
  storagePathProvider: KnowledgeStoragePathProvider
  /** 由 LanceDB 资源插件注入；缺席表示只启用文本检索。 */
  loadLanceDb?: KnowledgeLanceDbLoader
  embeddingRequestFactory: EmbeddingRequestFactory
  codeIntelligence?: KnowledgeCodeIntelligenceApi
  indexingPolicy?: KnowledgeIndexingPolicy
}

export interface KnowledgeApi {
  getDiagnostics: () => Promise<KnowledgeDiagnostics>
  reindexKnowledge: (
    options?: KnowledgeReindexOptions
  ) => Promise<KnowledgeReindexResult>
  ensureWorkspaceSynced: (
    workspaceRoot: string,
    options?: KnowledgeWorkspaceSyncOptions
  ) => Promise<KnowledgeWorkspaceSyncResult>
  searchKnowledge: (
    query: string,
    options: KnowledgeSearchOptions
  ) => Promise<KnowledgeSearchResult[]>
}

export interface KnowledgeProjectApi {
  getRootPath: () => string
}

export interface KnowledgeToolContext {
  abortSignal: AbortSignal
  sessionId: string
  knowledge: KnowledgeApi
  hasProjectRoot: () => boolean
  project: KnowledgeProjectApi
}

export type KnowledgeTool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> = ToolContractRuntimeSpec<
  TInput,
  KnowledgeToolContext,
  unknown,
  string
>

export type DefineKnowledgeToolInput<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> = DefineToolRuntimeSpecInput<
  TInput,
  KnowledgeToolContext,
  unknown,
  string
> & {
  category: 'knowledge'
}

export function defineKnowledgeTool<
  TInput extends Record<string, unknown>,
>(
  input: DefineKnowledgeToolInput<TInput>
): KnowledgeTool<TInput> {
  return defineToolRuntimeSpec(input)
}
