/**
 * 项目文件能力（`velaros:project`）的操作：`ProjectFileOperations` 与整个进程唯一的 `projectFileOperations`。接口 `ProjectFileOperationsApi` 在本文件的类上方。
 * 读操作在项目资源门的读门里跑（彼此并行、与写互斥）；改动在写门里跑：规划 → 内核准备、校验、提交，撤销同样。不问用户。
 * 校验与撤销账本都在项目内核里，这里只负责把模型的步骤编成事务、把结果写成模型面的样子。
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
import { changeRecordOf, changeTransactionOf } from '../../utils/agent/change-records.js'
import { commitProjectEdit } from '../../utils/agent/edit-commit.js'
import { changeInput, editInput } from '../../utils/agent/file-input.js'
import { listEntries, readFiles, searchFiles } from '../../utils/agent/file-reads.js'
import { planPathSteps } from '../../utils/agent/path-steps.js'
import { projectFailure } from '../../utils/agent/ports.js'
import { beforeWrite } from '../../utils/transactions/transaction-errors.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'

/**
 * @AgentView
 * 项目里的文件：读、列目录、搜源码，以及把几步文件改动合成一个事务。下面这些对每个方法都成立，各自的说明里不再重复：
 * 路径一律相对项目根（写成项目里的绝对路径也认），出不了项目，经符号链接指到外面的也不行。
 * 读出来的是连续的正文，带第一行的行号；改的时候按路径写：整份写入，或者把一段原文换成新文。
 * 改动经事务：一次 edit 全成或全不成，跑项目的校验器，保留文件原来的编码与换行；成了给 changeRef，inspect 看差量、undo 整次撤销。
 * 项目里的文件都能读能改，不问用户。生成出来的文件（*.generated.*、generated/ 下的这类）也改得动，但下次生成会被覆盖：一般改生成器的输入再重新生成。
 * 什么都不折叠：read 交回要的整段，list 交回全部条目，search 交回全部命中，edit、inspect 交回完整差量；看多少、筛什么在程序里定。
 * changeRef 只在本会话里有效，原样用，不能手写。
 * 失败时 error.code 是原因（INVALID_INPUT、TARGET_NOT_FOUND、AMBIGUOUS_TARGET、NOT_SUPPORTED、PERMISSION_DENIED、超过守内存上限的 SCOPE_VIOLATION……），error.message 写着为什么、下一步怎么办。
 */
export interface ProjectFileOperationsApi {
  /** @AgentView 读项目里的文本文件：交回连续的正文与它第一行的行号。看图用 `velaros:images`，目录用 list。
   * @OperationEffect none
   */
  read(input: ProjectReadInput, ctx: ProjectOperationContext): Promise<ProjectReadResult>
  /** @AgentView 列项目里的文件和目录，按深度优先的稳定顺序全部交回；.gitignore 忽略的与版本库内部（.git）不列。
   * @OperationEffect none
   */
  list(input: ProjectListInput, ctx: ProjectOperationContext): Promise<ProjectListResult>
  /** @AgentView 按字面文本或正则搜项目源码，交回全部命中与命中处连同前后几行的正文。
   * @OperationEffect none
   */
  search(input: ProjectSearchInput, ctx: ProjectOperationContext): Promise<ProjectSearchResult>
  /** @AgentView 改项目文件：按路径写整份或换一段原文，steps 按顺序合成一个事务提交。
   * @OperationEffect write
   */
  edit(input: ProjectEditInput, ctx: ProjectOperationContext): Promise<ProjectEditResult>
  /** @AgentView 看一次改动的差量与状态。
   * @OperationEffect none
   */
  inspect(input: ProjectChangeInput, ctx: ProjectOperationContext): Promise<ProjectChangeInspection>
  /** @AgentView 整次撤销一次改动：写回原文、删掉它新建的文件。
   * @OperationEffect write
   */
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

  public search(
    input: ProjectSearchInput,
    ctx: ProjectOperationContext
  ): Promise<ProjectSearchResult> {
    return this.guarded(ctx, false, () => searchFiles(input, ctx))
  }

  public async edit(
    input: ProjectEditInput,
    ctx: ProjectOperationContext
  ): Promise<ProjectEditResult> {
    try {
      ctx.abortSignal.throwIfAborted()
      // 按路径取读取凭据也排在写门里：同一个项目里别的改动落盘之后才取，取到的就是提交时的内容。
      return await this.gate.run(ctx.project.getRootPath(), true, ctx.abortSignal, async () => {
        const steps = await beforeWrite(() => planPathSteps(editInput(input).steps, ctx))
        return commitProjectEdit(steps, ctx)
      })
    } catch (error) {
      throw projectFailure(error)
    }
  }

  public async inspect(
    input: ProjectChangeInput,
    ctx: ProjectOperationContext
  ): Promise<ProjectChangeInspection> {
    try {
      ctx.abortSignal.throwIfAborted()
      const { changeRef } = changeInput(input)
      const record = changeRecordOf(changeRef, ctx)
      const transaction = await changeTransactionOf(ctx, record.transactionId, changeRef)
      const inspected: ProjectChangeInspection = {
        changeRef,
        status: transaction.status,
        changedFiles: transaction.changedFiles,
        diff: transaction.diff,
        diffLines: transaction.changedLines,
      }
      if (record.oldRevisions) inspected.oldRevisions = record.oldRevisions
      if (record.newRevisions) inspected.newRevisions = record.newRevisions
      return inspected
    } catch (error) {
      throw projectFailure(error)
    }
  }

  public async undo(
    input: ProjectChangeInput,
    ctx: ProjectOperationContext
  ): Promise<ProjectUndoResult> {
    try {
      ctx.abortSignal.throwIfAborted()
      const { changeRef, transactionId, transaction, kernel } = await beforeWrite(async () => {
        const { changeRef } = changeInput(input)
        const { transactionId } = changeRecordOf(changeRef, ctx)
        const transaction = await changeTransactionOf(ctx, transactionId, changeRef)
        return { changeRef, transactionId, transaction, kernel: await ctx.project.kernel() }
      })
      // 撤销是幂等的：已经撤销过就如实回执，不报错。
      if (transaction.status === 'rolled_back')
        return { changeRef, changedFiles: transaction.changedFiles, alreadyUndone: true }
      const rolled = await this.gate.run(ctx.project.getRootPath(), true, ctx.abortSignal, () =>
        kernel.rollback({ transactionId })
      )
      return { changeRef, changedFiles: rolled.changedFiles }
    } catch (error) {
      throw projectFailure(error)
    }
  }

  /** 在项目资源门里跑一个读操作；项目的领域错误翻成交给程序的错误。 */
  private async guarded<T>(
    ctx: ProjectOperationContext,
    write: boolean,
    action: () => Promise<T>
  ): Promise<T> {
    try {
      return await this.gate.run(ctx.project.getRootPath(), write, ctx.abortSignal, action)
    } catch (error) {
      throw projectFailure(error)
    }
  }
}

/** 整个进程只有一份的项目文件操作；项目空间把它挂在代码面的 `project` 命名空间上。 */
export const projectFileOperations: ProjectFileOperationsApi = new ProjectFileOperations(
  projectExecutionGate
)
