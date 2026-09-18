/**
 * 项目文件能力（`velar:project`）的操作：`ProjectFileOperations` 与整个进程唯一的 `projectFileOperations`。接口 `ProjectFileOperationsApi` 在本文件的类上方。
 * 读操作在项目资源门的读门里跑（彼此并行、与写互斥）；改动在写门里跑：规划 → 宿主的项目修改授权 → 内核准备、校验、提交，撤销同样。
 * 读取授权、脱敏、写授权、校验与撤销账本都在项目内核里，这里只负责把模型的步骤编成事务、把结果写成模型面的样子。
 */


import type { ProjectOperationContext } from '../../contract/requires.js'
import type {
  ProjectChangeInput,
  ProjectChangeInspection,
  ProjectEditInput,
  ProjectEditResult,
  ProjectListInput,
  ProjectListResult,
  ProjectReadInput,
  ProjectReadResult,
  ProjectSearchInput,
  ProjectSearchResult,
  ProjectUndoResult,
} from '../../types/files.js'
import { authorizeProjectWrite, changeRecordOf, changeTransactionOf } from '../../utils/agent/change-records.js'
import { commitProjectEdit } from '../../utils/agent/edit-commit.js'
import { changeInput, editInput } from '../../utils/agent/file-input.js'
import { listEntries, readFiles, searchFiles } from '../../utils/agent/file-reads.js'
import { locateEditSteps } from '../../utils/agent/planner-resolver.js'
import { projectFailure } from '../../utils/agent/ports.js'
import { projectApprovalBridge } from '../kernel/ProjectApprovalBridge.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'

/**
 * @AgentView
 * 项目里的文件：带行号的读、列目录、搜源码，以及把几步文件动作与源码编辑合成一个事务的改动。下面这些对每个方法都成立，各自的说明里不再重复：
 * 路径一律相对项目根（写成项目里的绝对路径也认），出不了项目，经符号链接指到外面的也不行。
 * 读出来的是带版本的窗口：lines 每项 [行号, 原文]，窗口上的 fileRef 是编辑凭据，edit 凭它核对文件没被改过、要改的行都读到过。
 * 改动经事务：一次 edit 全成或全不成，跑项目的校验器，保留文件原来的编码与换行；成了给 changeRef，inspect 看差量、undo 整次撤销。
 * 项目的读写策略管着这里：不许读的文件读不到，像密钥的片段读出来是遮住的（这样的窗口只能看不能改），生成文件、受保护文件改不了。
 * 什么都不折叠：read 交回要的整段，list 交回全部条目，search 交回全部命中，edit、inspect 交回完整差量；看多少、筛什么在程序里定。
 * 引用（fileRef、changeRef）只在本会话里有效，一律原样用，不能手写。
 * 失败时 error.code 是原因（INVALID_INPUT、TARGET_NOT_FOUND、NOT_SUPPORTED、PERMISSION_DENIED、BASE_REVISION_MISMATCH、超过守内存上限的 SCOPE_VIOLATION……），error.message 写着为什么、下一步怎么办。
 */
export interface ProjectFileOperationsApi {
  /** @AgentView 读项目里的文本文件：交回带行号的窗口，每个窗口带 fileRef。看图用 `velar:images`，目录用 list。 */
  read(input: ProjectReadInput, ctx: ProjectOperationContext): Promise<ProjectReadResult>
  /** @AgentView 列项目里的文件和目录，按深度优先的稳定顺序全部交回；.gitignore 忽略的与版本库内部（.git）不列。 */
  list(input: ProjectListInput, ctx: ProjectOperationContext): Promise<ProjectListResult>
  /** @AgentView 按字面文本或正则搜项目源码，交回全部命中；命中所在的行合成带 fileRef 的窗口，可以直接拿去 edit。 */
  search(input: ProjectSearchInput, ctx: ProjectOperationContext): Promise<ProjectSearchResult>
  /** @AgentView 改项目文件：steps 按顺序合成一个事务提交。要确认的只问一次，被拒就一个文件都不写。 */
  edit(input: ProjectEditInput, ctx: ProjectOperationContext): Promise<ProjectEditResult>
  /** @AgentView 看一次改动的差量与状态。 */
  inspect(input: ProjectChangeInput, ctx: ProjectOperationContext): Promise<ProjectChangeInspection>
  /** @AgentView 整次撤销一次改动：写回原文、删掉它新建的文件。 */
  undo(input: ProjectChangeInput, ctx: ProjectOperationContext): Promise<ProjectUndoResult>
}

export class ProjectFileOperations implements ProjectFileOperationsApi {
  constructor(private readonly gate: ProjectExecutionGateApi) {}

  public read(input: ProjectReadInput, ctx: ProjectOperationContext): Promise<ProjectReadResult> {
    return this.guarded(ctx, false, () => readFiles(input, ctx))
  }

  public list(input: ProjectListInput, ctx: ProjectOperationContext): Promise<ProjectListResult> {
    return this.guarded(ctx, false, () => listEntries(input, ctx))
  }

  public search(input: ProjectSearchInput, ctx: ProjectOperationContext): Promise<ProjectSearchResult> {
    return this.guarded(ctx, false, () => searchFiles(input, ctx))
  }

  public async edit(input: ProjectEditInput, ctx: ProjectOperationContext): Promise<ProjectEditResult> {
    try {
      ctx.abortSignal.throwIfAborted()
      const steps = await locateEditSteps(editInput(input).steps, ctx)
      return await projectApprovalBridge.run({ approval: ctx.approval, abortSignal: ctx.abortSignal }, () =>
        this.gate.run(ctx.project.getRootPath(), true, ctx.abortSignal, () => commitProjectEdit(steps, ctx)))
    } catch (error) {
      throw projectFailure(error)
    }
  }

  public async inspect(input: ProjectChangeInput, ctx: ProjectOperationContext): Promise<ProjectChangeInspection> {
    try {
      ctx.abortSignal.throwIfAborted()
      const { changeRef } = changeInput(input)
      const record = changeRecordOf(changeRef, ctx)
      const transaction = await changeTransactionOf(ctx, record.transactionId, changeRef)
      const inspected: ProjectChangeInspection = {
        changeRef, status: transaction.status, changedFiles: transaction.changedFiles,
        diff: transaction.diff, diffLines: transaction.changedLines,
      }
      if (record.oldRevisions) inspected.oldRevisions = record.oldRevisions
      if (record.newRevisions) inspected.newRevisions = record.newRevisions
      return inspected
    } catch (error) {
      throw projectFailure(error)
    }
  }

  public async undo(input: ProjectChangeInput, ctx: ProjectOperationContext): Promise<ProjectUndoResult> {
    try {
      ctx.abortSignal.throwIfAborted()
      const { changeRef } = changeInput(input)
      const { transactionId } = changeRecordOf(changeRef, ctx)
      const transaction = await changeTransactionOf(ctx, transactionId, changeRef)
      // 撤销是幂等的：已经撤销过就如实回执，不再问一次用户、也不报错。
      if (transaction.status === 'rolled_back') return { changeRef, changedFiles: transaction.changedFiles, alreadyUndone: true }
      await authorizeProjectWrite(ctx, '撤销项目文件的改动', transaction.changedFiles)
      const kernel = await ctx.project.kernel()
      const rolled = await projectApprovalBridge.run({ approval: ctx.approval, abortSignal: ctx.abortSignal }, () =>
        this.gate.run(ctx.project.getRootPath(), true, ctx.abortSignal, () => kernel.rollback({ transactionId })))
      return { changeRef, changedFiles: rolled.changedFiles }
    } catch (error) {
      throw projectFailure(error)
    }
  }

  /** 在项目资源门里跑一个读操作；项目的领域错误翻成交给程序的错误。 */
  private async guarded<T>(ctx: ProjectOperationContext, write: boolean, action: () => Promise<T>): Promise<T> {
    try {
      return await this.gate.run(ctx.project.getRootPath(), write, ctx.abortSignal, action)
    } catch (error) {
      throw projectFailure(error)
    }
  }

}

/** 整个进程只有一份的项目文件操作；项目空间把它挂在代码面的 `project` 命名空间上。 */
export const projectFileOperations: ProjectFileOperationsApi = new ProjectFileOperations(projectExecutionGate)
