/**
 * 记忆（`velaros:system` 的 memory 成员）的操作：`SystemMemoryOperations` 与整个进程唯一的 `systemMemoryOperations`。
 * 接口在本文件的类上方，按装配分三份：当前任务的工作记忆 `SystemMemoryOperationsWorkingApi`、安排整理的 `SystemMemoryOperationsOrganizeApi`、
 * 跨会话的长期记忆 `SystemMemoryOperationsLongTermApi`；四种合同投影（velaros:system-memory-local / system-memory / system-memory-persistent-local /
 * system-memory-persistent）各挂自己拿得到的那几份，实现是同一个类。
 * 工作记忆经会话的笔记存储与计划口读写，长期记忆复用 `velaros:memory` 的操作与宿主固定的作用域；上限由各自的存储核对。
 */

import type { TaskCapsule } from '@velaros-ai/context'
import { isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  MemoryIdInput,
  MemoryRemoved,
  MemorySaved,
  MemorySaveInput,
} from '@velaros-ai/velaros/memory'
import { memoryOperations } from '@velaros-ai/velaros/memory'

import { MemoryRecallLimits } from '../contract/constants.js'
import type { SystemMemoryOperationContext } from '../contract/requires.js'
import type {
  LongTermMemoryPage,
  LongTermMemoryQuery,
  MemoryContent,
  MemoryOrganizeIntent,
  MemoryOrganizeReceipt,
  MemoryPage,
  MemoryQuery,
  MemoryReadInput,
  MemoryReleaseInput,
  MemoryRetainInput,
  MemoryRetention,
} from '../types/memory.js'
import type { WorkspaceEntry, WorkspaceUpdate } from '../types/workspace.js'
import { assembledPort } from '../utils/ports.js'

/**
 * @AgentView
 * 当前任务的工作记忆：用户输入、脚本、执行结果、笔记与交付物都按原文归档，list 查目录、read 按引用读原文（读取不续租、不重跑脚本）。
 * update 维护自己的笔记（key + baseRevision），plan 维护任务计划；retain、release 调整笔记与执行结果是否自动展示。笔记与计划是你的解释，不能覆盖真实回执。
 * 改动只能在 execute 里做。
 */
export interface SystemMemoryOperationsWorkingApi {
  /** @AgentView 按种类与标题分页查当前任务的材料：只有引用、位置、大小与笔记版本。
   * @OperationEffect none
   */
  list(input: MemoryQuery, ctx: SystemMemoryOperationContext): Promise<MemoryPage>
  /** @AgentView 按引用分页读原文：输入、源码、结果、笔记与材料都用它。
   * @OperationEffect none
   */
  read(input: MemoryReadInput, ctx: SystemMemoryOperationContext): Promise<MemoryContent>
  /** @AgentView 改自己的一份笔记，交回它的新版本。
   * @OperationEffect write
   * @OperationModes execute
   */
  update(input: WorkspaceUpdate, ctx: SystemMemoryOperationContext): Promise<WorkspaceEntry>
  /** @AgentView 改自己的任务计划：只给要改的字段，其余保留，交回整份计划。
   * @OperationEffect write
   * @OperationModes execute
   */
  plan(input: Partial<TaskCapsule>, ctx: SystemMemoryOperationContext): Promise<TaskCapsule>
  /** @AgentView 保留一份笔记或执行结果的自动展示；不重跑脚本。
   * @OperationEffect write
   * @OperationModes execute
   */
  retain(input: MemoryRetainInput, ctx: SystemMemoryOperationContext): Promise<MemoryRetention>
  /** @AgentView 释放一份笔记或执行结果的自动展示，原文仍可召回。
   * @OperationEffect write
   * @OperationModes execute
   */
  release(input: MemoryReleaseInput, ctx: SystemMemoryOperationContext): Promise<MemoryRetention>
}

/** 安排上下文整理的那一份：只挂在具备整理模型的装配上。 */
export interface SystemMemoryOperationsOrganizeApi {
  /** @AgentView 声明下一阶段的 focus 与必须保留的引用，安排在下一次模型请求之前整理上下文；只是排队，结果出现在下一帧的 memoryStatus.maintenance。
   * @OperationEffect write
   * @OperationModes execute
   */
  organize(
    input: MemoryOrganizeIntent,
    ctx: SystemMemoryOperationContext
  ): Promise<MemoryOrganizeReceipt>
}

/**
 * @AgentView
 * 长期记忆：跨会话保存用户偏好、反馈、工作决定与资源位置，作用域由宿主固定。与当前任务的笔记不同，任务笔记用 update，跨会话的知识用 save。
 * 只保存以后仍然有用的；原始代码、临时结果与秘密留在它们的来源。记忆是写下那时的情况，使用前先核实。
 */
export interface SystemMemoryOperationsLongTermApi {
  /** @AgentView 分页召回长期记忆，含正文。
   * @OperationEffect none
   */
  recall(input: LongTermMemoryQuery, ctx: SystemMemoryOperationContext): Promise<LongTermMemoryPage>
  /** @AgentView 写一条长期记忆：同一个 id 整条覆盖，tags 不给就沿用原来的。防止过期写时，把 recall/save 的 revision 作为 expectedRevision；null 表示只许新建，省略版本表示最后提交覆盖，冲突报 CONFLICT 后重读再决定。
   * 从 recall 更新时先解构 const { revision, updatedAt, ...entry } = previous，再 save({ ...entry, content: 新正文, expectedRevision: revision })；revision 与 updatedAt 是读取结果字段，不直接放进写入输入。
   * @OperationEffect write
   * @OperationModes execute
   */
  save(input: MemorySaveInput, ctx: SystemMemoryOperationContext): Promise<MemorySaved>
  /** @AgentView 删掉一条长期记忆的原文；与 release 只释放当前任务的展示不同。可把 recall/save 的 revision 作为 expectedRevision，只删除该版本；null 要求条目不存在，省略版本删除当前条目，冲突报 CONFLICT。
   * @OperationEffect write
   * @OperationModes execute
   */
  remove(input: MemoryIdInput, ctx: SystemMemoryOperationContext): Promise<MemoryRemoved>
}

/** 三份合在一起的完整能力；实现类只有这一份。 */
export interface SystemMemoryOperationsApi
  extends
    SystemMemoryOperationsWorkingApi,
    SystemMemoryOperationsOrganizeApi,
    SystemMemoryOperationsLongTermApi {}

export class SystemMemoryOperations implements SystemMemoryOperationsApi {
  public async list(input: MemoryQuery, ctx: SystemMemoryOperationContext): Promise<MemoryPage> {
    ctx.abortSignal.throwIfAborted()
    return ctx.memory.catalog(input, ctx.abortSignal)
  }

  public async read(
    input: MemoryReadInput,
    ctx: SystemMemoryOperationContext
  ): Promise<MemoryContent> {
    ctx.abortSignal.throwIfAborted()
    const page = await ctx.memory.readMaterial(
      input.ref,
      input.offset,
      input.limit,
      ctx.abortSignal,
      input.pointer,
      input.invocation
    )
    if (!isUndefined(input.pointer) && page.pointer !== input.pointer)
      throw new AppError('UNAVAILABLE', '当前宿主不支持材料字段召回')
    if (!isUndefined(input.invocation) && page.invocation !== input.invocation)
      throw new AppError('UNAVAILABLE', '当前宿主不支持失败执行的调用回执召回')
    return page
  }

  public async update(
    input: WorkspaceUpdate,
    ctx: SystemMemoryOperationContext
  ): Promise<WorkspaceEntry> {
    ctx.abortSignal.throwIfAborted()
    return ctx.memory.update(input, ctx.abortSignal)
  }

  public async plan(
    input: Partial<TaskCapsule>,
    ctx: SystemMemoryOperationContext
  ): Promise<TaskCapsule> {
    ctx.abortSignal.throwIfAborted()
    return ctx.plans.updateCapsule(input, ctx.abortSignal, ctx.executionId)
  }

  public async retain(
    input: MemoryRetainInput,
    ctx: SystemMemoryOperationContext
  ): Promise<MemoryRetention> {
    ctx.abortSignal.throwIfAborted()
    return ctx.memory.retainMaterial(input.ref, input.turns ?? 'task', ctx.abortSignal)
  }

  public async release(
    input: MemoryReleaseInput,
    ctx: SystemMemoryOperationContext
  ): Promise<MemoryRetention> {
    ctx.abortSignal.throwIfAborted()
    return ctx.memory.retainMaterial(input.ref, null, ctx.abortSignal)
  }

  public async organize(
    input: MemoryOrganizeIntent,
    ctx: SystemMemoryOperationContext
  ): Promise<MemoryOrganizeReceipt> {
    ctx.abortSignal.throwIfAborted()
    return assembledPort(ctx.organizer, '整理服务').request(input, ctx.abortSignal)
  }

  public async recall(
    input: LongTermMemoryQuery,
    ctx: SystemMemoryOperationContext
  ): Promise<LongTermMemoryPage> {
    const entries = await memoryOperations.list({
      memory: assembledPort(ctx.longTerm, '长期记忆'),
      abortSignal: ctx.abortSignal,
    })
    ctx.abortSignal.throwIfAborted()
    const query = input.query?.trim().toLowerCase()
    const selected = entries.filter(
      (entry) =>
        (!input.id || entry.id === input.id) &&
        (!query ||
          [entry.id, entry.title, entry.description, ...entry.tags, entry.content]
            .join(' ')
            .toLowerCase()
            .includes(query))
    )
    // 分页越界按边界钳制，不拒绝：负偏移从头开始，页大小落在 1 到上限之间
    const offset = Math.max(0, Math.trunc(input.offset ?? 0))
    const limit = Math.min(
      Math.max(1, Math.trunc(input.limit ?? MemoryRecallLimits.page)),
      MemoryRecallLimits.maxPage
    )
    return {
      items: selected.slice(offset, offset + limit),
      total: selected.length,
      nextOffset: offset + limit < selected.length ? offset + limit : null,
    }
  }

  public async save(
    input: MemorySaveInput,
    ctx: SystemMemoryOperationContext
  ): Promise<MemorySaved> {
    return memoryOperations.save(input, {
      memory: assembledPort(ctx.longTerm, '长期记忆'),
      abortSignal: ctx.abortSignal,
    })
  }

  public async remove(
    input: MemoryIdInput,
    ctx: SystemMemoryOperationContext
  ): Promise<MemoryRemoved> {
    return memoryOperations.remove(input, {
      memory: assembledPort(ctx.longTerm, '长期记忆'),
      abortSignal: ctx.abortSignal,
    })
  }
}

/** 整个进程只有一份的记忆操作；装配时把本会话的笔记、计划、整理与长期记忆端口塞进每次调用的上下文。 */
export const systemMemoryOperations: SystemMemoryOperationsApi = new SystemMemoryOperations()
