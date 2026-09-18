import { isEmpty, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { KnowledgeIndexConfig, KnowledgeIndexStatuses } from '../../contract/constants.js'
import type {
  KnowledgeDiagnostics,
  KnowledgeReindexFailure,
  KnowledgeReindexOptions,
  KnowledgeReindexResult,
} from '../../types/knowledge.js'
import type { KnowledgeRepositoryApi } from '../storage/KnowledgeRepository.js'
import type { KnowledgeVectorsApi } from '../storage/KnowledgeVectors.js'

import type { KnowledgeMutationApi } from './KnowledgeMutation.js'

const log = Log.tag('KnowledgeMaintenance')

/**
 * 知识库维护服务：只读诊断、已禁用的启动维护，以及用户显式触发的手动补建。
 *
 * 自动同步不会走到这里——重建索引只能由记忆管理里的显式入口触发。
 */
export interface KnowledgeMaintenanceApi {
  /**
   * 汇总 SQLite 文档统计、文件索引统计、向量库统计与当前索引运行时。
   *
   * `workspaceSyncs` 由 `KnowledgeDomain` 从摄取服务合流补齐：那份台账是同步节流的真相源，
   * 维护服务不该为了一个读数反向依赖摄取服务。
   */
  getDiagnostics(): Promise<Omit<KnowledgeDiagnostics, 'workspaceSyncs'>>
  /** 启动自动重建已禁用，返回一份全零结果，说明这一轮什么都没做。 */
  runStartupMaintenance(): Promise<{ reindexedDocuments: number; failedReindexes: number }>
  /** 重建一批知识文档的索引；单篇失败不影响后面，失败逐条报回去。 */
  reindexKnowledge(options?: KnowledgeReindexOptions): Promise<KnowledgeReindexResult>
}

/** 见 {@link KnowledgeMaintenanceApi}。 */
export class KnowledgeMaintenance implements KnowledgeMaintenanceApi {
  constructor(
    private readonly repository: KnowledgeRepositoryApi,
    private readonly knowledgeMutationService: KnowledgeMutationApi,
    private readonly knowledgeVectors: KnowledgeVectorsApi
  ) {}

  public async getDiagnostics(): Promise<Omit<KnowledgeDiagnostics, 'workspaceSyncs'>> {
    const runtime = this.knowledgeMutationService.getCurrentIndexRuntime()
    const [baseDiagnostics, vectorStore] = await Promise.all([
      Promise.resolve(this.repository.getDiagnosticsBase(runtime)),
      this.knowledgeVectors.getStats(),
    ])

    return {
      ...baseDiagnostics,
      vectorStore,
      runtime,
    }
  }

  public async runStartupMaintenance(): Promise<{
    reindexedDocuments: number
    failedReindexes: number
  }> {
    log.info('knowledge startup reindex skipped')
    return {
      reindexedDocuments: 0,
      failedReindexes: 0,
    }
  }

  public async reindexKnowledge(options: KnowledgeReindexOptions = {}): Promise<KnowledgeReindexResult> {
    const startedAt = Date.now()
    const requestedIds = options.ids ?? []
    const hasExplicitIds = !isEmpty(requestedIds)
    const runtime = this.knowledgeMutationService.getCurrentIndexRuntime()
    // 这是显式手动入口：默认纳入异常、内容策略过期与当前 profile 缺失的文档。
    const candidates = this.repository.listKnowledgeForReindex(
      {
        ...options,
        statuses:
          options.statuses ??
          (hasExplicitIds
            ? undefined
            : [
                KnowledgeIndexStatuses.PENDING,
                KnowledgeIndexStatuses.PARTIAL,
                KnowledgeIndexStatuses.FAILED,
              ]),
        includeOutdated: options.includeOutdated ?? !hasExplicitIds,
        limit: options.limit ?? KnowledgeIndexConfig.MAX_LIST_LIMIT,
      },
      runtime
    )
    log.info('knowledge manual reindex start', {
      requested: isEmpty(requestedIds) ? candidates.length : requestedIds.length,
      candidates: candidates.length,
    })

    const failures: KnowledgeReindexFailure[] = []
    const foundIds = new Set(candidates.map((knowledge) => knowledge.id))

    for (const requestedId of requestedIds) {
      if (!foundIds.has(requestedId)) {
        // 显式指定的 id 如果被过滤掉或者不存在，也要反馈给调用方。
        failures.push({
          documentId: requestedId,
          message: '未找到可重建的知识文档，或该文档已被过滤',
        })
      }
    }

    let succeeded = 0
    for (const candidate of candidates) {
      try {
        // 单篇失败不影响后续文档，最后统一返回失败列表。
        await this.knowledgeMutationService.reindexKnowledge(candidate.id)
        succeeded += 1
      } catch (error) {
        const message = AppError.getMessage(error)
        failures.push({
          documentId: candidate.id,
          message,
        })
        log.warn('knowledge reindex item failed', {
          documentId: candidate.id,
        })
      }
    }

    const result = {
      requested: isEmpty(requestedIds) ? candidates.length : requestedIds.length,
      succeeded,
      failed: failures.length,
      failures,
    }
    log.info('knowledge manual reindex end', {
      requested: result.requested,
      succeeded: result.succeeded,
      failed: result.failed,
      durationMs: Date.now() - startedAt,
    })
    return result
  }
}
