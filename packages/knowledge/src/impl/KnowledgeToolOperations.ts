import { isEmpty } from '@velaros-ai/core'

import type { KnowledgeToolContext } from '../contract/requires.js'
import type {
  KnowledgeDiagnostics,
  KnowledgeSearchResult,
  KnowledgeSourceKind,
  KnowledgeWorkspaceSyncResult,
} from '../types/knowledge.js'
import type { KnowledgeIndexIssue } from '../types/tool.js'
import { summarizeKnowledgeIndexIssues } from '../utils/index-issues.js'
import { resolveWorkspaceRoot } from '../utils/tools.js'

/** `knowledge:sync` 的入参。 */
export interface KnowledgeToolOperationsSyncInput extends Record<string, unknown> {
  /** 工作区根目录；省略时用宿主当前激活的那个。 */
  workspaceRoot?: string
  /** 跳过短时 TTL 强制重新同步。 */
  force?: boolean
}

/** `knowledge:search` 的入参。 */
export interface KnowledgeToolOperationsSearchInput extends Record<string, unknown> {
  /** 检索语句。 */
  query: string
  /** 工作区根目录；省略时用宿主当前激活的那个。 */
  workspaceRoot?: string
  /** 只要这些来源类型。 */
  sourceKinds?: KnowledgeSourceKind[]
  /** 路径提示，抬高相关文件的排序。 */
  pathHints?: string[]
  /** 符号提示，抬高相关代码知识的排序。 */
  symbolHints?: string[]
  /** 把范围限定在这些知识文档 id 上。 */
  documentIds?: string[]
  /** 最多返回几条。 */
  limit?: number
}

/** `knowledge:sync` 的回执。 */
export interface KnowledgeToolOperationsSyncResult {
  /** 这一轮同步跑过了。 */
  synced: true
  /** 实际用的工作区根。 */
  workspaceRoot: string
  /** 同步的增量统计。 */
  result: KnowledgeWorkspaceSyncResult
}

/** `knowledge:search` 的回执。 */
export interface KnowledgeToolOperationsSearchResult {
  /** 原样回显检索语句。 */
  query: string
  /** 实际用的工作区根。 */
  workspaceRoot: string
  /** 命中条数。 */
  count: number
  /** 这批结果里记着的索引问题，按原因归类。 */
  indexIssues: KnowledgeIndexIssue[]
  /** 只在零命中补过索引时出现：扫了多少、建了多少，以及一句说明。 */
  autoSync?: {
    /** 这一轮补索引扫了多少个文件。 */
    scanned: number
    /** 这一轮补索引新建或更新了多少份文档。 */
    indexed: number
    /** 给模型的一句说明：补过索引之后已经重搜过了。 */
    note: string
  }
  /** 命中的知识文档。 */
  results: KnowledgeSearchResult[]
}

/**
 * 三个知识工具的执行体：解析工作区根、零命中补一次同步再重搜、拼回执。
 *
 * 工具文件只放定义，一行交给这里；实例是本文件末尾的 `knowledgeToolOperations`，无状态。
 */
export interface KnowledgeToolOperationsApi {
  /** `knowledge:diagnostics`：只读透传领域层的诊断结果。 */
  diagnostics(ctx: KnowledgeToolContext): Promise<{ diagnostics: KnowledgeDiagnostics }>
  /** `knowledge:sync`：先定工作区根，再把 force 作为增量扫描选项交给领域层。 */
  sync(
    input: KnowledgeToolOperationsSyncInput,
    ctx: KnowledgeToolContext
  ): Promise<KnowledgeToolOperationsSyncResult>
  /** `knowledge:search`：绑定工作区检索；零命中时补一次增量同步再重搜一次。 */
  search(
    input: KnowledgeToolOperationsSearchInput,
    ctx: KnowledgeToolContext
  ): Promise<KnowledgeToolOperationsSearchResult>
}

/** 见 {@link KnowledgeToolOperationsApi}。 */
class KnowledgeToolOperations implements KnowledgeToolOperationsApi {
  public async diagnostics(
    ctx: KnowledgeToolContext
  ): Promise<{ diagnostics: KnowledgeDiagnostics }> {
    // 诊断只读，直接透传领域层结果。
    const diagnostics = await ctx.knowledge.getDiagnostics()

    return { diagnostics }
  }

  public async sync(
    input: KnowledgeToolOperationsSyncInput,
    ctx: KnowledgeToolContext
  ): Promise<KnowledgeToolOperationsSyncResult> {
    // 同步前先确定工作区根，再把 force 作为增量扫描选项传给领域层。
    const effectiveWorkspaceRoot = await resolveWorkspaceRoot(input.workspaceRoot, ctx)
    const result = await ctx.knowledge.ensureWorkspaceSynced(effectiveWorkspaceRoot, {
      force: input.force,
    })

    return {
      synced: true,
      workspaceRoot: effectiveWorkspaceRoot,
      result,
    }
  }

  public async search(
    input: KnowledgeToolOperationsSearchInput,
    ctx: KnowledgeToolContext
  ): Promise<KnowledgeToolOperationsSearchResult> {
    // 搜索同样绑定工作区，避免跨项目召回污染回答。
    const effectiveWorkspaceRoot = await resolveWorkspaceRoot(input.workspaceRoot, ctx)
    const search = (): Promise<KnowledgeSearchResult[]> =>
      ctx.knowledge.searchKnowledge(input.query, {
        workspaceRoot: effectiveWorkspaceRoot,
        sourceKinds: input.sourceKinds,
        pathHints: input.pathHints,
        symbolHints: input.symbolHints,
        documentIds: input.documentIds,
        limit: input.limit,
      })

    let results = await search()
    /**
     * **fail-open**（原则 12：可用性类失败要向「还能用」的方向倒）。
     *
     * 零命中有两种完全不同的原因：「这个项目里真没有」与「索引压根没建过」。调用方看到的
     * `count: 0` 长得一模一样，于是要么误判「项目里没有」，要么去猜该不该先调 knowledge:sync
     * ——一个只有读过实现才知道答案的仪式。这里替它做掉：零命中就补一次增量同步再重搜，
     * 并在结果里如实说明发生过什么。
     *
     * 只在零命中时触发，且 `ensureWorkspaceSynced` 自带 TTL：有索引的工作区不会被反复扫盘。
     * 同步失败也不改变失败方向——搜索本身已经成功了，把它降级成报错等于让一个可选的加速步骤
     * 毁掉一次正常召回。
     */
    let autoSync: Nullable<KnowledgeWorkspaceSyncResult> = null
    if (isEmpty(results)) {
      autoSync = await ctx.knowledge
        .ensureWorkspaceSynced(effectiveWorkspaceRoot)
        // @arch-guard:suspend code-style/require-error-logging 理由：自动同步是零命中时的补救步骤，失败经返回值 autoSync=null 如实上报，不得改写搜索本身的成败。
        .catch(() => null)
      ctx.abortSignal.throwIfAborted()
      if (autoSync && autoSync.upserted + autoSync.reindexed > 0) results = await search()
    }

    const summary: KnowledgeToolOperationsSearchResult = {
      query: input.query,
      workspaceRoot: effectiveWorkspaceRoot,
      count: results.length,
      indexIssues: summarizeKnowledgeIndexIssues(results),
      results,
    }
    // 只在真的补过索引时出现：常态结果里没有这个键（`in` 判定为假），不带一个恒 null 的字段。
    if (autoSync) {
      summary.autoSync = {
        scanned: autoSync.scanned,
        indexed: autoSync.upserted + autoSync.reindexed,
        note: '本次零命中，已自动为该工作区补建/更新索引后重搜。',
      }
    }
    return summary
  }
}

/** 三个知识工具共用的一份执行体。 */
export const knowledgeToolOperations: KnowledgeToolOperationsApi = new KnowledgeToolOperations()
