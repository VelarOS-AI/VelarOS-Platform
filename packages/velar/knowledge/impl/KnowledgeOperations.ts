/**
 * 知识检索能力（`velar:knowledge`）的操作：`KnowledgeOperations` 与整个进程唯一的 `knowledgeOperations`。接口 `KnowledgeOperationsApi` 在本文件的类上方。
 * 一份实现挂在哪个空间都一样，空间之间的差别全在调用上下文里的端口 `KnowledgeSpacePort` 上。
 */

import { isEmpty } from '@velaros-ai/core'

import type { KnowledgeOperationContext } from '../contract/requires.js'
import type { KnowledgeFound, KnowledgeHealth, KnowledgeSearchInput, KnowledgeSynced, KnowledgeSyncInput } from '../types/knowledge.js'
import { summarizeIndexIssues } from '../utils/index-issues.js'
import { searchInput, syncInput } from '../utils/input.js'
import { projectHealth, projectHit } from '../utils/mapper.js'

/**
 * @AgentView
 * 工作区知识库：在已经建好的索引里检索文档与代码知识（全文加语义的混合检索），需要时增量同步、看索引健康。
 * 检索是只读的：零命中而这个工作区还没建过索引时，会自动补一次增量同步再重搜，结果里的 autoSync 说明这件事。
 * 知道路径就直接读文件，不用检索；要找代码里的符号与引用用代码能力，这里找的是知识。
 */
export interface KnowledgeOperationsApi {
  /** @AgentView 检索知识：交回按相关度排好的命中，每条带整份正文与命中处的片段。 */
  search(input: KnowledgeSearchInput, ctx: KnowledgeOperationContext): Promise<KnowledgeFound>
  /** @AgentView 把工作区的文档、配置与代码增量同步进索引：刚改过一批文件、想马上搜到时用。 */
  sync(input: KnowledgeSyncInput, ctx: KnowledgeOperationContext): Promise<KnowledgeSynced>
  /** @AgentView 看索引健康：文档总数、各状态的数量、当前嵌入模型覆盖了多少、各工作区最近同步时刻。只读。 */
  diagnostics(ctx: KnowledgeOperationContext): Promise<KnowledgeHealth>
}

/**
 * 顺序是固定的：先查取消、再核对入参、再定工作区、最后做事——入参错了一步都不做。
 * 零命中时补一次同步是这里替模型做掉的：「这个工作区里真没有」和「索引压根没建过」交回来都是零条，
 * 模型分不出来，要么误判没有，要么猜该不该先同步。
 */
export class KnowledgeOperations implements KnowledgeOperationsApi {
  public async search(input: KnowledgeSearchInput, ctx: KnowledgeOperationContext): Promise<KnowledgeFound> {
    ctx.abortSignal.throwIfAborted()
    const { query, workspaceRoot, ...request } = searchInput(input)
    const root = await ctx.knowledge.resolveWorkspace(workspaceRoot)
    const search = () => ctx.knowledge.searchKnowledge(query, { ...request, workspaceRoot: root })
    let records = await search()
    let autoSync: Nullable<KnowledgeSynced> = null
    if (isEmpty(records)) {
      // 补索引是零命中时的补救步骤：它失败不改写搜索本身的成败，只是不出现 autoSync。
      // @arch-guard:suspend code-style/require-error-logging 理由：自动同步失败经返回值（没有 autoSync）如实交给程序，不改写检索的成败。
      autoSync = await ctx.knowledge.ensureWorkspaceSynced(root).catch(() => null)
      ctx.abortSignal.throwIfAborted()
      if (autoSync && autoSync.upserted + autoSync.reindexed > 0) records = await search()
    }
    const results = records.map(projectHit)
    const found: KnowledgeFound = { workspaceRoot: root, count: results.length, results, indexIssues: summarizeIndexIssues(results) }
    if (autoSync) found.autoSync = { scanned: autoSync.scanned, indexed: autoSync.upserted + autoSync.reindexed }
    return found
  }

  public async sync(input: KnowledgeSyncInput, ctx: KnowledgeOperationContext): Promise<KnowledgeSynced> {
    ctx.abortSignal.throwIfAborted()
    const { workspaceRoot, force } = syncInput(input)
    const root = await ctx.knowledge.resolveWorkspace(workspaceRoot)
    const synced = await ctx.knowledge.ensureWorkspaceSynced(root, { force })
    return {
      workspaceRoot: synced.workspaceRoot,
      scanned: synced.scanned,
      upserted: synced.upserted,
      reindexed: synced.reindexed,
      reindexBlocked: synced.reindexBlocked,
      removed: synced.removed,
      skipped: synced.skipped,
      forced: synced.forced,
    }
  }

  public async diagnostics(ctx: KnowledgeOperationContext): Promise<KnowledgeHealth> {
    ctx.abortSignal.throwIfAborted()
    return projectHealth(await ctx.knowledge.getDiagnostics())
  }
}

/** 整个进程只有一份的知识检索操作；空间把它挂在代码面的 `knowledge` 命名空间上。 */
export const knowledgeOperations: KnowledgeOperationsApi = new KnowledgeOperations()
