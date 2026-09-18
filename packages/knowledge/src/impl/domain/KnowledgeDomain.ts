import type {
  KnowledgeDiagnostics,
  KnowledgeReindexOptions,
  KnowledgeReindexResult,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeWorkspaceSyncOptions,
  KnowledgeWorkspaceSyncResult,
} from '../../types/knowledge.js'
import type { KnowledgeVectorsApi } from '../storage/KnowledgeVectors.js'

import type { KnowledgeIngestionApi } from './KnowledgeIngestion.js'
import type { KnowledgeMaintenanceApi } from './KnowledgeMaintenance.js'
import type { KnowledgeQueryApi } from './KnowledgeQuery.js'

/**
 * 知识库的领域门面：上层只关心「同步 / 搜索 / 诊断 / 重建」，这里负责协调摄取、查询、维护与向量库生命周期。
 *
 * 它是宿主接线的主入口，实例由知识库运行时给出。
 */
export interface KnowledgeDomainApi {
  /** 预热向量库，一般在应用启动时调用。 */
  warmup(): Promise<void>
  /** 关闭向量库连接。 */
  close(): void
  /** 汇总 SQLite、文件索引、向量库诊断，以及各工作区的最近同步时刻。 */
  getDiagnostics(): Promise<KnowledgeDiagnostics>
  /** 手动重建一批知识文档的索引。 */
  reindexKnowledge(options?: KnowledgeReindexOptions): Promise<KnowledgeReindexResult>
  /** 启动时维护；当前实现不自动重建，返回一份全零结果。 */
  runStartupMaintenance(): Promise<{ reindexedDocuments: number; failedReindexes: number }>
  /** 确保一个工作区的文档类知识已经同步。 */
  ensureWorkspaceSynced(
    workspaceRoot: string,
    options?: KnowledgeWorkspaceSyncOptions
  ): Promise<KnowledgeWorkspaceSyncResult>
  /**
   * 搜索知识库。
   *
   * 这必须是纯读路径，不触发同步、索引或重建。索引维护由手动入口、项目打开生命周期，
   * 或模型面 `velar:knowledge` 的 search 在**零命中时**显式补一次 `ensureWorkspaceSynced` 触发——
   * 那一层看得见「这次什么都没搜到」，本方法看不见，也不该在读路径上替调用方决定写。
   */
  searchKnowledge(
    query: string,
    options: KnowledgeSearchOptions
  ): Promise<KnowledgeSearchResult[]>
}

/** 见 {@link KnowledgeDomainApi}。 */
export class KnowledgeDomain implements KnowledgeDomainApi {
  constructor(
    private readonly ingestionService: KnowledgeIngestionApi,
    private readonly queryService: KnowledgeQueryApi,
    private readonly knowledgeMaintenanceService: KnowledgeMaintenanceApi,
    private readonly vectorStore: KnowledgeVectorsApi
  ) {}

  public async warmup(): Promise<void> {
    await this.vectorStore.warmup()
  }

  public close(): void {
    this.vectorStore.close()
  }

  public async getDiagnostics(): Promise<KnowledgeDiagnostics> {
    const diagnostics = await this.knowledgeMaintenanceService.getDiagnostics()
    // 「上次同步是什么时候」住在摄取服务里（它才知道 TTL 按谁计的）；诊断面在这里合流，
    // 而不是让维护服务反向依赖摄取服务去问一个它不拥有的读数。
    return { ...diagnostics, workspaceSyncs: this.ingestionService.listWorkspaceSyncStates() }
  }

  public async reindexKnowledge(options: KnowledgeReindexOptions = {}): Promise<KnowledgeReindexResult> {
    return this.knowledgeMaintenanceService.reindexKnowledge(options)
  }

  public async runStartupMaintenance(): Promise<{
    reindexedDocuments: number
    failedReindexes: number
  }> {
    return this.knowledgeMaintenanceService.runStartupMaintenance()
  }

  public async ensureWorkspaceSynced(
    workspaceRoot: string,
    options: KnowledgeWorkspaceSyncOptions = {}
  ): Promise<KnowledgeWorkspaceSyncResult> {
    return this.ingestionService.ensureWorkspaceSynced(workspaceRoot, options)
  }

  public async searchKnowledge(
    query: string,
    options: KnowledgeSearchOptions
  ): Promise<KnowledgeSearchResult[]> {
    return this.queryService.searchKnowledge(query, options)
  }
}
