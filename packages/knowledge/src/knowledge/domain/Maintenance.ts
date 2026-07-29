import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { KnowledgeIndexConfig, KnowledgeIndexStatuses } from '../../Constants'
import type { KnowledgeRepo } from '../storage'
import type { KnowledgeVectors } from '../storage'

import type { KnowledgeMutation } from './Mutation'
import type {
  KnowledgeDiagnostics,
  KnowledgeReindexFailure,
  KnowledgeReindexOptions,
  KnowledgeReindexResult,
} from './Types'

const log = logRuntime.tag('KnowledgeMaintenance')

/** 启动维护任务结果。 */
export interface KnowledgeStartupMaintenanceResult {
  reindexedDocuments: number
  failedReindexes: number
}

/**
 * 知识库维护服务。
 *
 * 提供只读诊断、禁用态启动维护和用户显式手动补建能力。
 */
export class KnowledgeMaintenance {
  constructor(
    private readonly repository: KnowledgeRepo,
    private readonly knowledgeMutationService: KnowledgeMutation,
    private readonly knowledgeVectors: KnowledgeVectors
  ) {}

  /** 汇总 SQLite 文档统计、文件索引统计、向量库统计和当前索引 runtime。 */
  public async getDiagnostics(): Promise<KnowledgeDiagnostics> {
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

  /** 启动自动重建已禁用；重建索引只能由记忆管理手动触发。 */
  public async runStartupMaintenance(): Promise<KnowledgeStartupMaintenanceResult> {
    log.info('knowledge startup reindex skipped')
    return {
      reindexedDocuments: 0,
      failedReindexes: 0,
    }
  }

  /** 重建一批知识文档索引。 */
  public async reindexKnowledge(options: KnowledgeReindexOptions = {}): Promise<KnowledgeReindexResult> {
    const startedAt = Date.now()
    const requestedIds = options.ids ?? []
    const hasExplicitIds = !isEmpty(requestedIds)
    const runtime = this.knowledgeMutationService.getCurrentIndexRuntime()
    // 这是显式手动入口：默认纳入异常、内容策略过期和当前 profile 缺失的文档。
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
        // 显式指定的 id 如果被过滤或不存在，也要反馈给调用方。
        failures.push({
          documentId: requestedId,
          message: '未找到可重建的知识文档，或该文档已被过滤',
        })
      }
    }

    let succeeded = 0
    for (const candidate of candidates) {
      try {
        // 单个文档失败不影响后续文档，最终统一返回失败列表。
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
