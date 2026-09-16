/**
 * 注入面：宿主必须或可以塞进来的东西。
 *
 * 知识库自己不打开数据库、不挑向量模型、不发现工作区，也不认识桌面端或编辑器；
 * 这些能力一律经这里的端口注入。每个接口写清楚谁给、什么时候给、必不必须。
 * 这里的每个声明都从根入口导出。
 */

import type * as LanceDbPackage from '@lancedb/lancedb'
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

/** 取一条宿主管理的 SQLite 连接。必给：关系型索引全落在它上面，开关与事务调度都归宿主。 */
export type KnowledgeDatabaseProvider = () => InstanceType<typeof BetterSqlite3>

/** 向量库目录在哪。必给：LanceDB 的数据目录由宿主决定，本包不认识产品的数据目录约定。 */
export interface KnowledgeStoragePathProvider {
  /** 返回 LanceDB 数据目录的绝对路径。 */
  getLanceDatabasePath: () => string
}

/** 一条已经打开的 LanceDB 连接；由向量插件注入的模块建出来。 */
export interface KnowledgeLanceDbConnection {
  /** 列出库里已有的表名。 */
  tableNames: () => ReturnType<LanceDbPackage.Connection['tableNames']>
  /** 打开一张已有的表。 */
  openTable: (name: string) => ReturnType<LanceDbPackage.Connection['openTable']>
  /** 用第一批行建一张新表。 */
  createTable: (
    name: string,
    data: Parameters<LanceDbPackage.Connection['createTable']>[1]
  ) => ReturnType<LanceDbPackage.Connection['createTable']>
  /** 关闭连接。 */
  close: () => void
}

/**
 * 向量插件注入的最小模块端口。
 *
 * 只在真的要读写向量时才被调用；宿主没装插件就不给这个端口，知识库仍保留 SQLite 全文检索与工作区摄入，
 * 不会因为原生库缺席而阻断启动。
 */
export interface KnowledgeLanceDbModule {
  /** 按目录连上向量库。 */
  connect: (path: string) => Promise<KnowledgeLanceDbConnection>
  /** 建索引要用的三种索引构造器。 */
  Index: Pick<typeof LanceDbPackage.Index, 'btree' | 'bitmap' | 'ivfFlat'>
}

/** 按需加载向量插件模块；可选，缺席表示只启用文本检索。 */
export type KnowledgeLanceDbLoader = () => Promise<KnowledgeLanceDbModule>

/**
 * 嵌入模型的选择与可用性是宿主的事。
 *
 * 本包每次生成向量前都向它要一次最新配置，宿主换了模型下一次嵌入立刻用新答案；
 * 本包不读模型目录、不读服务商清单、不读任何环境变量约定。必给。
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

/** 宿主注入的代码智能能力；可选，缺席时代码候选退回本包自带的正则扫描。 */
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

/** 宿主的工作区可见性策略；可选，缺席时只按本包默认名单跳过依赖、版本控制、缓存与隐藏系统目录。 */
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

/**
 * 宿主端口：三个知识工具经上下文里的 `ctx.knowledge` 调它。
 *
 * 只放工具真会调的方法——显式重建索引是设置页的入口，不是模型面工具的能力，所以不在这里。
 */
export interface KnowledgeToolApi {
  /** 只读诊断：文档总量、内容策略过期、当前 profile 覆盖率、保留的向量状态。 */
  getDiagnostics: () => Promise<KnowledgeDiagnostics>
  /** 确保这个工作区的文档类知识已经同步，带短时 TTL。 */
  ensureWorkspaceSynced: (
    workspaceRoot: string,
    options?: KnowledgeWorkspaceSyncOptions
  ) => Promise<KnowledgeWorkspaceSyncResult>
  /** 在已建索引里做一次混合检索，纯读路径。 */
  searchKnowledge: (
    query: string,
    options: KnowledgeSearchOptions
  ) => Promise<KnowledgeSearchResult[]>
}

/** 宿主当前激活的工作区；工具没拿到 workspaceRoot 时向它要一个根。 */
export interface KnowledgeProjectApi {
  /** 返回当前激活工作区的根路径。 */
  getRootPath: () => string
}

/** 宿主每次调用知识工具时解析出来的上下文。 */
export interface KnowledgeToolContext {
  /** 本次调用的取消信号。 */
  abortSignal: AbortSignal
  /** 本次调用所属的会话 id。 */
  sessionId: string
  /** 知识库宿主端口。 */
  knowledge: KnowledgeToolApi
  /** 宿主这一刻有没有激活的工作区。 */
  hasProjectRoot: () => boolean
  /** 当前激活的工作区。 */
  project: KnowledgeProjectApi
}
