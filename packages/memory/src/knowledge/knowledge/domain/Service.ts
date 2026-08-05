import type { KnowledgeIngestion } from '../ingestion'
import type { KnowledgeVectors } from '../storage'

import type { KnowledgeMaintenance } from './Maintenance'
import type { KnowledgeStartupMaintenanceResult } from './Maintenance'
import type { KnowledgeQuery } from './Query'
import type {
  KnowledgeDiagnostics,
  KnowledgeReindexOptions,
  KnowledgeReindexResult,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeWorkspaceSyncOptions,
  KnowledgeWorkspaceSyncResult,
} from './Types'

/**
 * 知识库领域服务门面。
 *
 * 上层只关心“同步/搜索/诊断/重建”，这里负责协调摄取服务、查询服务、维护服务和向量库生命周期。
 */
class KnowledgeDomain {
  constructor(
    private readonly ingestionService: KnowledgeIngestion,
    private readonly queryService: KnowledgeQuery,
    private readonly knowledgeMaintenanceService: KnowledgeMaintenance,
    private readonly vectorStore: KnowledgeVectors
  ) {}

  /** 预热知识向量库，通常在应用启动时调用。 */
  public async warmup(): Promise<void> {
    await this.vectorStore.warmup()
  }

  /** 关闭向量库连接。 */
  public close(): void {
    this.vectorStore.close()
  }

  /** 汇总知识库 SQLite、文件索引、向量库诊断与各工作区的最近同步时刻。 */
  public async getDiagnostics(): Promise<KnowledgeDiagnostics> {
    const diagnostics = await this.knowledgeMaintenanceService.getDiagnostics()
    // 「上次同步是什么时候」住在摄取服务里（它才知道 TTL 是按谁计的）；诊断面在这里合流，
    // 而不是让维护服务反向依赖摄取服务去问一个它不拥有的读数。
    return { ...diagnostics, workspaceSyncs: this.ingestionService.listWorkspaceSyncStates() }
  }

  /** 手动重建一批知识文档索引。 */
  public async reindexKnowledge(options: KnowledgeReindexOptions = {}): Promise<KnowledgeReindexResult> {
    return this.knowledgeMaintenanceService.reindexKnowledge(options)
  }

  /** 启动时维护，例如补建 pending/failed/outdated 文档索引。 */
  public async runStartupMaintenance(): Promise<KnowledgeStartupMaintenanceResult> {
    return this.knowledgeMaintenanceService.runStartupMaintenance()
  }

  /** 确保工作区文档类知识已经同步。 */
  public async ensureWorkspaceSynced(
    workspaceRoot: string,
    options: KnowledgeWorkspaceSyncOptions = {}
  ): Promise<KnowledgeWorkspaceSyncResult> {
    return this.ingestionService.ensureWorkspaceSynced(workspaceRoot, options)
  }

  /**
   * 搜索知识库。
   *
   * 搜索必须是纯读取路径，不能触发同步、索引或重建索引。
   * 索引维护由手动入口、项目打开生命周期，或 `knowledge:search` 工具在**零命中时**显式补一次
   * `ensureWorkspaceSynced`（工具层的 fail-open，见 Knowledge.tool.ts）触发——那一层看得见
   * 「这次搜索什么都没搜到」，本方法看不见，也不该在读路径上替调用方决定写。
   */
  public async searchKnowledge(
    query: string,
    options: KnowledgeSearchOptions
  ): Promise<KnowledgeSearchResult[]> {
    return this.queryService.searchKnowledge(query, options)
  }
}

export { KnowledgeDomain }
