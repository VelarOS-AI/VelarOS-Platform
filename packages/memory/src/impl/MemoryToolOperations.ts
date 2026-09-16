import { isEmpty, isNumber, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { GLOBAL_MEMORY_SCOPE } from '../contract/constants'
import type { MemoryToolContext } from '../contract/requires'
import type { MemoryEvidenceCategory } from '../types/memory'
import type {
  ForgetMemoryInput,
  ForgetMemoryResult,
  GetMemoryInput,
  GetMemoryResult,
  SaveMemoryInput,
  SaveMemoryResult,
  SearchMemoriesInput,
  SearchMemoriesResult,
} from '../types/tool'
import { scopeTypeForScopeId } from '../utils/scope'
import {
  compactRecallItem,
  defaultPrivacyClassFor,
  inferWorkspaceRoot,
  isMemoryReadableInScope,
  normalizeMemoryCategory,
  ProfileCategories,
} from '../utils/tools'
import { MemoryTuning } from '../utils/tuning'

/**
 * 四个记忆工具的执行体。
 *
 * 工具文件只写定义，每个 execute 一行交给这里；这一层只经 `ctx.memory` 调宿主端口，
 * 不认识后端是树、文件还是并联了向量索引。整个进程共用 `memoryToolOperations` 这一份（无状态）。
 */
export interface MemoryToolOperationsApi {
  /** 写一条带来源的长期记忆；后端拒收时当场如实报错，绝不回一句「已记下」。 */
  save(input: SaveMemoryInput, ctx: MemoryToolContext): Promise<SaveMemoryResult>
  /** 按当前空间作用域召回，投影成紧凑条目。 */
  search(input: SearchMemoriesInput, ctx: MemoryToolContext): Promise<SearchMemoriesResult>
  /** 按 id 读全文与来源，过跨作用域读门。 */
  get(input: GetMemoryInput, ctx: MemoryToolContext): Promise<GetMemoryResult>
  /** 归档一条记忆：先过与 `memory:get` 同一条读门，再如实回报归没归成。 */
  archive(input: ForgetMemoryInput, ctx: MemoryToolContext): Promise<ForgetMemoryResult>
}

/** 记忆工具执行体实现。 */
export class MemoryToolOperations implements MemoryToolOperationsApi {
  /** 工具写下的内容缺省来源标注。 */
  private static readonly DefaultSource = '记忆工具'

  public async save(input: SaveMemoryInput, ctx: MemoryToolContext): Promise<SaveMemoryResult> {
    ctx.abortSignal.throwIfAborted()
    const workspaceRoot = inferWorkspaceRoot(input.workspaceRoot, ctx.memoryScope)
    const memoryScope = ctx.memoryScope?.trim()
    const backend = ctx.memory.describeBackend()
    const result = await ctx.memory.captureEvidence({
      // 工具内容的作者是模型，不是用户：信任级封顶在 agent_derived，绝不由模型自报的
      // 「用户已确认」铸造 user_stated/user_correction。真实用户确认经聊天消息采集独立进入
      // user_stated 证据；放行自报会给 prompt injection 一条伪造「用户已确认」的提权通道。
      sourceType: 'agent_tool',
      trustLevel: 'agent_derived',
      sessionId: ctx.sessionId,
      workspaceRoot,
      scopeType: memoryScope ? scopeTypeForScopeId(memoryScope) : undefined,
      scopeId: memoryScope,
      title: input.title,
      content: input.content,
      category: normalizeMemoryCategory(input.kind),
      privacyClass: input.privacyClass ?? defaultPrivacyClassFor(input.kind),
      metadata: {
        summary: input.summary ?? '',
        source: input.source ?? MemoryToolOperations.DefaultSource,
        tags: input.tags ?? [],
        taskKey: input.taskKey ?? '',
        sessionLineage: toNullable(ctx.sessionLineage),
      },
    })
    // 后端拒收（证据的作用域没有对应的可写记忆目录）时不给条目 id：当场如实报错，
    // 绝不回一句「已记下」让模型去向用户承诺一件没发生的事。
    if (!result.evidence.id) {
      throw new AppError(
        'VALIDATION',
        `当前空间（${memoryScope || '未指定作用域'}）没有对应的记忆目录，这条记忆没有写下来；`
          + '请如实告诉用户，不要说已经记住了。',
      )
    }
    // 有整理管线的后端（树档）写入即入队、由后台整理择时纳入；没有的后端写入即最终态。
    // 对模型只说这一件能兑现的事，treeVersion 这类某一档的 schema 只在该档在跑时才回。
    const consolidating = backend.verbs.includes('dream')
    const treeVersion = consolidating ? (await ctx.memory.getDiagnostics()).treeVersion : undefined
    const written: SaveMemoryResult = {
      accepted: true,
      inserted: result.inserted,
      memoryId: result.evidence.id,
      availability: consolidating ? 'consolidating' : 'immediate',
      message: consolidating
        ? '已记下；由后台整理管线择时纳入长期结论。'
        : '已记下，现在就能被召回。',
    }
    // 「没有整理管线的后端不回 treeVersion」是契约（`in` 判定为假），所以只在有版本号时写这个键。
    if (isNumber(treeVersion)) written.treeVersion = treeVersion
    return written
  }

  public async search(input: SearchMemoriesInput, ctx: MemoryToolContext): Promise<SearchMemoriesResult> {
    ctx.abortSignal.throwIfAborted()
    const mode = input.mode ?? 'search'
    const workspaceRoot = inferWorkspaceRoot(input.workspaceRoot, ctx.memoryScope)
    const query = mode === 'profile' ? '' : input.query?.trim() ?? ''
    const categories: LooseOptional<MemoryEvidenceCategory[]> = mode === 'profile'
      ? [...ProfileCategories]
      : input.categories?.map(normalizeMemoryCategory)
    // 按当前空间作用域收敛召回：browser/system 空间若不传 scopeId，recall 的有效作用域
    // 为空 = 无作用域过滤，会翻出所有项目/站点的条目。global（记忆管理面）才代表「全部」。
    const memoryScope = ctx.memoryScope?.trim()
    const scopeId = memoryScope && memoryScope !== GLOBAL_MEMORY_SCOPE ? memoryScope : undefined
    const limit = input.limit
      ?? (mode === 'search' ? MemoryTuning.tools.searchDefaultLimit : MemoryTuning.tools.browseDefaultLimit)
    const memories = await ctx.memory.recall(query, {
      limit,
      workspaceRoot,
      scopeId,
      categories,
      includeDormant: input.deep,
      deep: input.deep,
    })
    return { mode, query, count: memories.length, memories: memories.map(compactRecallItem) }
  }

  public async get(input: GetMemoryInput, ctx: MemoryToolContext): Promise<GetMemoryResult> {
    ctx.abortSignal.throwIfAborted()
    const memory = await ctx.memory.getMemory(input.id)
    // 越界与不存在回同一个 NOT_FOUND：分开回等于把「这条存在但不属于你」当成信息泄漏出去。
    if (!memory || !isMemoryReadableInScope(memory, ctx.memoryScope)) {
      throw new AppError('NOT_FOUND', `记忆不存在：${input.id}`)
    }
    return { memory }
  }

  public async archive(input: ForgetMemoryInput, ctx: MemoryToolContext): Promise<ForgetMemoryResult> {
    ctx.abortSignal.throwIfAborted()
    // 归档是写动作，先过和 `memory:get` 同一条可见性读门：没有这一道，项目会话拿到一个
    // 系统池的 id 就能把别人空间的记忆归档掉（系统根总在根列表里）。越界与不存在回同一个
    // NOT_FOUND——分开回等于把「这条存在但不属于你」当成信息泄漏出去。
    const memory = await ctx.memory.getMemory(input.id)
    if (!memory || !isMemoryReadableInScope(memory, ctx.memoryScope)) {
      throw new AppError('NOT_FOUND', `记忆不存在：${input.id}`)
    }
    const result = await ctx.memory.archiveMemory(input.id)
    // 后端一条都没归档到（例如只读根）时如实回 false，别再对模型说「已归档」。
    const archived = !isEmpty(result.affectedEvidenceIds)
    return {
      archived,
      physicalDelete: false as const,
      reason: toNullable(input.reason),
      ...result,
      message: archived
        ? '已归档：这条记忆退出日常召回，内容仍在，深层召回仍可翻到。'
        : '没有归档成：这条记忆所在的作用域根是只读的，请如实告诉用户，别说已经归档。',
    }
  }
}

/** 整个进程共用的工具执行体实例。 */
export const memoryToolOperations: MemoryToolOperationsApi = new MemoryToolOperations()
