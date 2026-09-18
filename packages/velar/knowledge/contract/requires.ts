/**
 * 注入面：宿主与空间必须或可以塞进来的东西。
 *
 * - 调用上下文 `KnowledgeOperationContext`：必须。空间每次分发 `velar:knowledge` 的调用时给，里面是取消信号与空间端口 `KnowledgeSpacePort`。
 * - 造一份知识库运行时要的端口 `KnowledgeRuntimeProviders`：宿主给，一个数据目录或租户一份。
 *
 * 知识库自己不打开数据库、不挑向量模型、不发现工作区，也不认识桌面端或编辑器；
 * 这些能力一律经这里的端口注入。每个接口写清楚谁给、什么时候给、必不必须。
 * 这里的每个声明都从根入口导出。
 */

import type BetterSqlite3 from 'better-sqlite3'

import type {
  KnowledgeCodeFileNodeRequest,
  KnowledgeCodeNode,
  KnowledgeCodeNodeRequest,
  KnowledgeCodeNodeSearchRequest,
  KnowledgeCodeRelevantContextRequest,
  KnowledgeCodeSearchResult,
  KnowledgeCodeSubgraph,
} from '../types/code.js'
import type {
  EmbeddingRequest,
  EmbeddingRequestConfig,
  KnowledgeEmbeddingRuntime,
} from '../types/host.js'
import type {
  KnowledgeDiagnostics,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeWorkspaceSyncOptions,
  KnowledgeWorkspaceSyncResult,
} from '../types/knowledge.js'
import type { KnowledgeVectorRow, LanceIndexDescriptor } from '../types/storage.js'

/** 取一条宿主管理的 SQLite 连接。必给：关系型索引全落在它上面，开关与事务调度都归宿主。 */
export type KnowledgeDatabaseProvider = () => InstanceType<typeof BetterSqlite3>

/** 向量库目录在哪。必给：LanceDB 的数据目录由宿主决定，本单元不认识产品的数据目录约定。 */
export interface KnowledgeStoragePathProvider {
  /** 返回 LanceDB 数据目录的绝对路径。 */
  getLanceDatabasePath: () => string
}

// 向量插件的端口：下面几个形状是本单元自己的，只写本单元真用到的操作，LanceDB 模块结构上满足它们
// （`check:memory-knowledge-profile` 把真的 LanceDB 交进来跑一遍）。插件是可选 peer，
// 声明里不引它的类型，没装插件的宿主照样能严格编译本单元。

/** 建索引的选项：索引配置原样交回，已有索引不替换，最多等这么久。 */
export interface KnowledgeLanceDbIndexOptions {
  /** 模块的索引构造器交出的配置；本单元不看里面。 */
  config?: unknown
  /** 已有同名索引时要不要替换。 */
  replace?: boolean
  /** 等索引建好的秒数上限。 */
  waitTimeoutSeconds?: number
}

/** 一次按键合并写入：链上配好命中与没命中时怎么做，再交数据执行。 */
export interface KnowledgeLanceDbMergeInsert {
  /** 键命中的行整行更新。 */
  whenMatchedUpdateAll(): KnowledgeLanceDbMergeInsert
  /** 键没命中的行插进去。 */
  whenNotMatchedInsertAll(): KnowledgeLanceDbMergeInsert
  /** 表里有、这批数据里没有、又满足条件的行删掉。 */
  whenNotMatchedBySourceDelete(options: {
    /** 只删满足这个谓词的行。 */
    where: string
  }): KnowledgeLanceDbMergeInsert
  /** 交这批行执行合并。 */
  execute(rows: KnowledgeVectorRow[]): Promise<unknown>
}

/** 一次向量相似度检索：链上配好距离、探测数、条数与过滤，再执行。 */
export interface KnowledgeLanceDbVectorQuery {
  /** 距离度量，本单元只用余弦。 */
  distanceType(type: 'cosine'): KnowledgeLanceDbVectorQuery
  /** 向量索引要探测的分区数。 */
  nprobes(count: number): KnowledgeLanceDbVectorQuery
  /** 最多交回几条。 */
  limit(count: number): KnowledgeLanceDbVectorQuery
  /** 过滤谓词。 */
  where(predicate: string): KnowledgeLanceDbVectorQuery
  /** 执行并交回全部命中行。 */
  toArray(): Promise<Array<Record<string, unknown>>>
}

/** 表的 Arrow schema 里本单元读的那一点：每一列的名字与类型（向量列的类型带定长维度 listSize）。 */
export interface KnowledgeLanceDbSchema {
  /** 表的各列。 */
  fields: ReadonlyArray<{
    /** 列名。 */
    name: string
    /** 列类型；本单元只从向量列的类型里读 listSize。 */
    type: unknown
  }>
}

/** 一张向量表：一个嵌入 profile 一张，本单元只用这几样操作。 */
export interface KnowledgeLanceDbTable {
  /** 表里一共多少行。 */
  countRows(): Promise<number>
  /** 列出表上已有的索引。 */
  listIndices(): Promise<LanceIndexDescriptor[]>
  /** 在一列上建索引。 */
  createIndex(column: string, options?: KnowledgeLanceDbIndexOptions): Promise<void>
  /** 删掉满足谓词的行。 */
  delete(predicate: string): Promise<unknown>
  /** 以某一列为键起一次合并写入。 */
  mergeInsert(on: string): KnowledgeLanceDbMergeInsert
  /** 以一个查询向量起一次相似度检索。 */
  vectorSearch(vector: number[]): KnowledgeLanceDbVectorQuery
  /** 读表的 schema。 */
  schema(): Promise<KnowledgeLanceDbSchema>
  /** 关掉这张表。 */
  close(): void
}

/** 一条已经打开的向量库连接；由向量插件注入的模块建出来。 */
export interface KnowledgeLanceDbConnection {
  /** 列出库里已有的表名。 */
  tableNames(): Promise<string[]>
  /** 打开一张已有的表。 */
  openTable(name: string): Promise<KnowledgeLanceDbTable>
  /** 用第一批行建一张新表。 */
  createTable(name: string, data: KnowledgeVectorRow[]): Promise<KnowledgeLanceDbTable>
  /** 关闭连接。 */
  close(): void
}

/**
 * 向量插件注入的最小模块端口；宿主把 LanceDB 模块本身交进来就行。
 *
 * 只在真的要读写向量时才被调用；宿主没装插件就不给这个端口，知识库仍保留 SQLite 全文检索与工作区摄入，
 * 不会因为原生库缺席而阻断启动。
 */
export interface KnowledgeLanceDbModule {
  /** 按目录连上向量库。 */
  connect(path: string): Promise<KnowledgeLanceDbConnection>
  /** 建索引要用的三种索引构造器；交出的配置原样交回 `createIndex`。 */
  Index: {
    /** 标量列的 B 树索引。 */
    btree(): unknown
    /** 低基数标量列的位图索引。 */
    bitmap(): unknown
    /** 向量列的 IVF-Flat 索引。 */
    ivfFlat(options: {
      /** 距离度量，本单元只用余弦。 */
      distanceType: 'cosine'
    }): unknown
  }
}

/** 按需加载向量插件模块；可选，缺席表示只启用文本检索。 */
export type KnowledgeLanceDbLoader = () => Promise<KnowledgeLanceDbModule>

/**
 * 嵌入模型的选择与可用性是宿主的事。
 *
 * 本单元每次生成向量前都向它要一次最新配置，宿主换了模型下一次嵌入立刻用新答案；
 * 本单元不读模型目录、不读服务商清单、不读任何环境变量约定。必给。
 */
export interface KnowledgeEmbeddingConfigPort {
  /** 解析出这一刻可用的嵌入运行时。 */
  resolveEmbeddingRuntime: () => KnowledgeEmbeddingRuntime
  /** 当前是不是用户动作触发的链路；只有用户动作或回答生成链路才允许生成向量。 */
  isManualEmbeddingAllowed?: () => boolean
  /** 当前是不是回答生成链路。 */
  isAnswerEmbeddingAllowed?: () => boolean
}

/** 发 JSON 请求的通用 HTTP 客户端。必给：嵌入请求默认走它，除非注入式 provider 自带执行函数。 */
export interface KnowledgeHttpClient {
  /** 发一次 JSON POST 并解析响应。 */
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

/** 按服务商协议拼一条嵌入请求。必给：不同服务商的请求形状由宿主的适配层决定。 */
export interface KnowledgeEmbeddingRequestFactory {
  /** 按配置、模型与待嵌入文本拼出一条请求。 */
  createEmbeddingRequest: (
    config: EmbeddingRequestConfig,
    model: string,
    texts: string[]
  ) => EmbeddingRequest
}

/** 宿主注入的代码智能能力；可选，缺席时代码候选退回本单元自带的正则扫描。 */
export interface KnowledgeCodeIntelligenceApi {
  /** 这套能力这一刻可不可用。 */
  readonly available: boolean
  /** 这个项目有没有开启代码智能。 */
  isProjectEnabled: (projectRoot: string) => boolean
  /** 按关键词搜代码节点。 */
  searchNodes: (input: KnowledgeCodeNodeSearchRequest) => Promise<KnowledgeCodeSearchResult[]>
  /** 取某个文件里的全部代码节点。 */
  getNodesInFile: (input: KnowledgeCodeFileNodeRequest) => Promise<KnowledgeCodeNode[]>
  /** 按任务描述取相关代码子图。 */
  findRelevantContext: (input: KnowledgeCodeRelevantContextRequest) => Promise<KnowledgeCodeSubgraph>
  /** 取某个代码节点的原文。 */
  getCodeForNode: (input: KnowledgeCodeNodeRequest) => Promise<Nullable<string>>
}

/** 宿主的工作区可见性策略；可选，缺席时只按本单元默认名单跳过依赖、版本控制、缓存与隐藏系统目录。 */
export interface KnowledgeIndexingPolicy {
  /** 返回假就把这一项挡在索引之外。 */
  shouldIncludeEntry?: (input: {
    name: string
    isDirectory: boolean
    relativePath: string
  }) => boolean
}

/** 造一个知识库运行时要塞进来的全部端口，一个数据目录或租户一份。 */
export interface KnowledgeRuntimeProviders {
  /** 嵌入模型配置端口。 */
  embeddingConfig: KnowledgeEmbeddingConfigPort
  /** 通用 HTTP 客户端。 */
  httpClient: KnowledgeHttpClient
  /** SQLite 连接来源。 */
  databaseProvider: KnowledgeDatabaseProvider
  /** 向量库目录来源。 */
  storagePathProvider: KnowledgeStoragePathProvider
  /** 由向量插件注入；缺席表示只启用文本检索。 */
  loadLanceDb?: KnowledgeLanceDbLoader
  /** 嵌入请求工厂。 */
  embeddingRequestFactory: KnowledgeEmbeddingRequestFactory
  /** 可选的代码智能能力。 */
  codeIntelligence?: KnowledgeCodeIntelligenceApi
  /** 可选的工作区可见性策略。 */
  indexingPolicy?: KnowledgeIndexingPolicy
}

// ── 代码面：velar:knowledge 的调用上下文与空间端口 ─────────────────

/** 每次调用拿到的上下文：取消信号与空间端口。 */
export interface KnowledgeOperationContext {
  /** 本次调用的取消信号；用户取消或上层超时时触发，操作和宿主都要尽快收手。 */
  abortSignal: AbortSignal
  /** 空间端口：操作经它定工作区、向知识库要检索、同步与诊断，写作 `ctx.knowledge`。 */
  knowledge: KnowledgeSpacePort
}

/**
 * 空间端口：`velar:knowledge` 的操作在运行时能向空间要什么，写作 `ctx.knowledge`。全仓唯一权威。
 *
 * 后三个方法就是领域门面 `KnowledgeDomainApi` 的那三个，宿主把 `createKnowledgeRuntime(...).knowledgeDomainService` 直接转过去；
 * `resolveWorkspace` 是空间自己的决定。端口里只有操作真会调的方法，门禁按操作文件核对。
 */
export interface KnowledgeSpacePort {
  /**
   * 这次检索、同步落在哪个工作区：给了就按空间的规矩解析（比如相对路径、`~`）；没给用空间自己的（项目空间是项目根）。
   * 空间没有默认工作区、调用又没给时抛 `VALIDATION`，说清要给 workspaceRoot——不猜一个根，也不跨根兜底。
   */
  resolveWorkspace(requested: Optional<string>): string | Promise<string>
  /** 只读诊断：文档总量、各状态的数量、当前嵌入模型的覆盖、各工作区最近同步时刻。 */
  getDiagnostics(): Promise<KnowledgeDiagnostics>
  /** 确保这个工作区的文档与代码知识已经同步，带短时节流；force 为真时跳过节流。 */
  ensureWorkspaceSynced(workspaceRoot: string, options?: KnowledgeWorkspaceSyncOptions): Promise<KnowledgeWorkspaceSyncResult>
  /** 在已建的索引里做一次混合检索，纯读路径：不同步、不重建。 */
  searchKnowledge(query: string, options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult[]>
}
