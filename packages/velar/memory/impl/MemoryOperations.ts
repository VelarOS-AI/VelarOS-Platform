/**
 * 长期记忆能力（`velar:memory`）的操作：`MemoryOperations` 与整个进程唯一的 `memoryOperations`。接口 `MemoryOperationsApi` 在本文件的类上方。
 * 一份实现挂在哪个空间都一样，空间之间的差别全在调用上下文里：这一次调用的作用域、会话与空间端口 `MemorySpacePort`。
 * 来源与信任级、去重键、作用域可见性读门、「有没有整理管线」这些记忆域的规则就在这里，只有这一处。
 */

import { isEmpty, isNumber, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { MemoryScopeIds } from '../contract/constants.js'
import type { MemoryOperationContext } from '../contract/requires.js'
import type {
  MemoryArchived,
  MemoryFound,
  MemoryIdInput,
  MemoryItem,
  MemorySaved,
  MemorySaveInput,
  MemorySearchInput,
} from '../types/memory.js'
import { hashStableKey } from '../utils/files/entries.js'
import { idInput, saveInput, searchInput } from '../utils/input.js'
import { projectItem } from '../utils/mapper.js'
import { defaultPrivacyClassFor, inferWorkspaceRoot, readVisibleMemory } from '../utils/operations.js'
import { scopeTypeForScopeId } from '../utils/scope.js'

/**
 * @AgentView
 * 长期记忆：跨会话记住用户的偏好、纠正、目标与稳定事实，以及对以后还有用的任务、项目、做法与产出。
 * 只在当前空间（当前项目、当前站点或系统空间）里读写，别的空间的看不到，拿别的空间的 id 也当作不存在。
 * 写之前想清楚：不要保存密码、Token、Cookie、私钥或恢复码；不要把没有证据的推断写成用户事实；只对当前回合有用的临时步骤不要存。
 * 你写下的内容作者是你，不是用户——不要声称「用户已确认」。召回到的记忆带着可信度与来源，不要当成无来源的绝对事实。
 */
export interface MemoryOperationsApi {
  /** @AgentView 写一条长期记忆：用户明确表达的长期偏好、纠正、目标或稳定事实，或对以后还有用的任务、项目、做法与产出。 */
  save(input: MemorySaveInput, ctx: MemoryOperationContext): Promise<MemorySaved>
  /** @AgentView 召回当前空间的长期记忆：回答依赖用户的历史、偏好、项目连续性或既有结论时先召回。 */
  search(input: MemorySearchInput, ctx: MemoryOperationContext): Promise<MemoryFound>
  /** @AgentView 按 id 读一条记忆的内容与来源。 */
  get(input: MemoryIdInput, ctx: MemoryOperationContext): Promise<MemoryItem>
  /** @AgentView 归档一条记忆，让它退出日常召回：用户明确说某条过时了、暂时不想它影响回答时用。不是删除；用户要彻底删除时如实说现在只能归档。 */
  archive(input: MemoryIdInput, ctx: MemoryOperationContext): Promise<MemoryArchived>
}

/** 顺序是固定的：先查取消、再核对入参、最后做事——入参错了一步都不做。整个进程共用一份，无状态。 */
export class MemoryOperations implements MemoryOperationsApi {
  /** 写下的内容缺省来源标注。 */
  private static readonly DefaultSource = '记忆工具'

  public async save(input: MemorySaveInput, ctx: MemoryOperationContext): Promise<MemorySaved> {
    ctx.abortSignal.throwIfAborted()
    const checked = saveInput(input)
    // 落点只由作用域两轴决定：入参里没有根，模型传什么都改变不了写到哪。
    const workspaceRoot = inferWorkspaceRoot(undefined, ctx.memoryScope)
    const memoryScope = ctx.memoryScope?.trim()
    const backend = ctx.memory.describeBackend()
    const result = await ctx.memory.captureEvidence({
      // 这条内容的作者是模型，不是用户：信任级封顶在 agent_derived，绝不由模型自报的
      // 「用户已确认」铸造 user_stated/user_correction。真实用户确认经聊天消息采集独立进入
      // user_stated 证据；放行自报会给 prompt injection 一条伪造「用户已确认」的提权通道。
      sourceType: 'agent_tool',
      trustLevel: 'agent_derived',
      // 稳定去重键：同一个作用域里，类别、标题、正文都一样的内容再写一次不会多出一条。
      // 两个后端据此得到同一个判据——树档按 (sourceType, sourceId) 去重，文件档按同一把键找回条目。
      sourceId: hashStableKey(`${memoryScope ?? ''}|${checked.kind}|${checked.title}|${checked.content}`),
      sessionId: ctx.sessionId,
      workspaceRoot,
      scopeType: memoryScope ? scopeTypeForScopeId(memoryScope) : undefined,
      scopeId: memoryScope,
      title: checked.title,
      content: checked.content,
      category: checked.kind,
      // 隐私级不进模型面：没有任何行为读它，缺省按类别推，披露闸门接线时再由宿主决定要不要开。
      privacyClass: defaultPrivacyClassFor(checked.kind),
      metadata: {
        summary: checked.summary ?? '',
        source: checked.source ?? MemoryOperations.DefaultSource,
        tags: checked.tags ?? [],
        taskKey: checked.taskKey ?? '',
        sessionLineage: toNullable(ctx.sessionLineage),
      },
    })
    // 后端拒收（证据的作用域没有对应的可写记忆目录）时不给条目 id：当场如实报错，
    // 绝不让模型去向用户承诺一件没发生的事。
    if (!result.evidence.id) {
      throw new AppError(
        'VALIDATION',
        `当前空间（${memoryScope || '未指定作用域'}）没有对应的记忆目录，这条记忆没有写下来；`
          + '请如实告诉用户，不要说已经记住了。',
      )
    }
    // 有整理管线的后端（树档）写入即入队、由后台整理择时纳入；没有的后端写入即最终态。
    const consolidating = backend.verbs.includes('dream')
    const treeVersion = consolidating ? (await ctx.memory.getDiagnostics()).treeVersion : undefined
    const saved: MemorySaved = {
      memoryId: result.evidence.id,
      inserted: result.inserted,
      availability: consolidating ? 'consolidating' : 'immediate',
    }
    // 「没有整理管线的后端不回 treeVersion」是契约（`in` 判定为假），所以只在有版本号时写这个键。
    if (isNumber(treeVersion)) saved.treeVersion = treeVersion
    return saved
  }

  public async search(input: MemorySearchInput, ctx: MemoryOperationContext): Promise<MemoryFound> {
    ctx.abortSignal.throwIfAborted()
    const request = searchInput(input)
    // 按当前空间作用域收敛召回：browser/system 空间若不传 scopeId，recall 的有效作用域
    // 为空 = 无作用域过滤，会翻出所有项目/站点的条目。global（记忆管理面）才代表「全部」。
    const memoryScope = ctx.memoryScope?.trim()
    const scopeId = memoryScope && memoryScope !== MemoryScopeIds.global ? memoryScope : undefined
    const recalled = await ctx.memory.recall(request.query, {
      limit: request.limit,
      workspaceRoot: inferWorkspaceRoot(undefined, ctx.memoryScope),
      scopeId,
      categories: request.categories,
      includeDormant: request.deep,
      deep: request.deep,
    })
    const memories = recalled.map(projectItem)
    return { query: request.query, count: memories.length, memories }
  }

  public async get(input: MemoryIdInput, ctx: MemoryOperationContext): Promise<MemoryItem> {
    ctx.abortSignal.throwIfAborted()
    return projectItem(await readVisibleMemory(idInput(input, 'get'), ctx))
  }

  public async archive(input: MemoryIdInput, ctx: MemoryOperationContext): Promise<MemoryArchived> {
    ctx.abortSignal.throwIfAborted()
    const id = idInput(input, 'archive')
    // 归档是写动作，先过和 get 同一条可见性读门：没有这一道，项目会话拿到一个
    // 系统池的 id 就能把别人空间的记忆归档掉（系统根总在根列表里）。
    await readVisibleMemory(id, ctx)
    const result = await ctx.memory.archiveMemory(id)
    // 后端一条都没归档到（例如只读根）时如实回 false。
    return { archived: !isEmpty(result.affectedEvidenceIds), affectedEvidenceIds: [...result.affectedEvidenceIds] }
  }
}

/** 整个进程只有一份的记忆操作；空间把它挂在代码面的 `memory` 命名空间上。 */
export const memoryOperations: MemoryOperationsApi = new MemoryOperations()
