/**
 * 项目文件能力（`velaros:project`）的操作：`ProjectFileOperations` 与整个进程唯一的 `projectFileOperations`。接口 `ProjectFileOperationsApi` 在本文件的类上方。
 * 读操作在项目资源门的读门里跑（彼此并行、与写互斥）；改动在写门里跑：规划 → 内核准备、校验、提交，撤销同样。不问用户。
 * 校验与撤销账本都在项目内核里，这里只负责把模型的步骤编成事务、把结果写成模型面的样子。
 */

import { optionalWhen } from '@velaros-ai/core'

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
import type { ProjectSnapshotCapture, ProjectSnapshotInput } from '../../types/observation.js'
import type {
  ProjectPatchInput,
  ProjectPatchResult,
  ProjectSelectInput,
  ProjectSelectResult,
} from '../../types/selection.js'
import { changeRecordOf, changeTransactionOf } from '../../utils/agent/change-records.js'
import { commitProjectEdit } from '../../utils/agent/edit-commit.js'
import { changeInput, editInput } from '../../utils/agent/file-input.js'
import { listEntries, readFiles, searchFiles } from '../../utils/agent/file-reads.js'
import { planPathSteps } from '../../utils/agent/path-steps.js'
import { projectFailure } from '../../utils/agent/ports.js'
import { patchSelections } from '../../utils/agent/selection-patch.js'
import { selectSources } from '../../utils/agent/selection-reads.js'
import { beforeWrite } from '../../utils/transactions/transaction-errors.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'
import { ProjectSnapshotCollector } from './ProjectSnapshotCollector.js'

/**
 * @AgentView
 * 按需使用的项目事务、冲突保护与撤回。普通读写、遍历和搜索使用 Node 与成熟库，不必改走本模块。下面这些对每个方法都成立：
 * 路径一律相对项目根（写成项目里的绝对路径也认），出不了项目，经符号链接指到外面的也不行。
 * 需要事务时优先一次 edit：直接传路径、oldText/newText 或 text；Node 已读的完整原文可作 write.expectedText，不必先 read/select。read/select + patch 仅在需要结构定位、特殊编码读取或减少大块传输时使用。
 * 改动经事务：一次 edit 全成或全不成，跑项目的校验器，保留文件原来的编码与换行；成了给 changeRef，inspect 看差量、undo 整次撤销。
 * 项目里的文件都能读能改，不问用户。生成出来的文件（*.generated.*、generated/ 下的这类）也改得动，但下次生成会被覆盖：一般改生成器的输入再重新生成。
 * read 交回要的整段，list 全部条目，search 全部命中；patch 缺省摘要，edit、inspect 完整差量；看多少、筛什么在程序里定。
 * changeRef 只在本会话里有效，原样用，不能手写。
 * 失败时 error.code 是原因（INVALID_INPUT、TARGET_NOT_FOUND、AMBIGUOUS_TARGET、NOT_SUPPORTED、PERMISSION_DENIED、超过守内存上限的 SCOPE_VIOLATION……），error.message 写着为什么、下一步怎么办。
 */
export interface ProjectFileOperationsApi {
  /** @AgentView 读项目里的文本文件：交回连续的正文与它第一行的行号。批量读取的失败项在 issues；后续改动依赖全部文件时先处理这些缺口，不把返回的 files 当作全部请求都已读。看图用 `velaros:images`，目录用 list。
   * @OperationEffect none
   */
  read(input: ProjectReadInput, ctx: ProjectOperationContext): Promise<ProjectReadResult>
  /** @AgentView 捕获声明式 files 纯快照计划：最多 20 个文件、每次捕获 500000 个字符；在同一项目读门内前后完整读取，任何缺失、截断或前后变化都失败。快照只证明此次捕获值相同，不能证明读取期间没有 ABA，也不授予后续写入或跳过 IO。
   * @OperationEffect none
   */
  snapshot(
    input: ProjectSnapshotInput,
    ctx: ProjectOperationContext
  ): Promise<ProjectSnapshotCapture>
  /** @AgentView 列项目里的文件和目录，按深度优先的稳定顺序全部交回；.gitignore 忽略的与版本库内部（.git）不列。
   * @OperationEffect none
   */
  list(input: ProjectListInput, ctx: ProjectOperationContext): Promise<ProjectListResult>
  /** @AgentView 按字面文本或正则搜项目源码，交回全部命中与连续正文。contextLines 为每处前后各带的行数，缺省 1，接受非负安全整数；窗口止于文件边界，相交或相邻的窗口合并。合并后的正文总量不超过 20000000 个 Unicode 字符；超限减小 contextLines、收窄范围或用 read 带 range 分段读取。
   * @OperationEffect none
   */
  search(input: ProjectSearchInput, ctx: ProjectOperationContext): Promise<ProjectSearchResult>
  /** @AgentView 精确定位函数/方法等结构或作用域中的字面片段；返回连续原文和工具绑定的目标。歧义明确选择候选，issues 未解决时不要提交成功子集。
   * @OperationEffect none
   */
  select(input: ProjectSelectInput, ctx: ProjectOperationContext): Promise<ProjectSelectResult>
  /** @AgentView 批量编辑 read/select 的目标：新块或片段一次拼接、整批事务提交。缺省摘要，完整 diff 用 inspect。blocked 明确未写入，并可用 planRef/amendments 只修正问题项；取消或写入状态不明仍抛错。
   * @OperationEffect write
   * @OperationModes execute
   */
  patch(input: ProjectPatchInput, ctx: ProjectOperationContext): Promise<ProjectPatchResult>
  /** @AgentView 一次提交可撤回的文件事务，无需先 read/select：replace 用唯一 oldText 定位，write 可用 Node 已读的完整 expectedText 防止覆盖外部改动，expectedText:null 只允许新建。相关 steps 一起提交；省略 expectedText 的 write 按提交时内容覆盖。拆成多次调用时不能承诺跨调用原子性。
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
  private readonly snapshots = new ProjectSnapshotCollector()
  constructor(private readonly gate: ProjectExecutionGateApi) {}

  public read(input: ProjectReadInput, ctx: ProjectOperationContext): Promise<ProjectReadResult> {
    return this.guarded(ctx, false, () => readFiles(input, ctx))
  }

  public snapshot(
    input: ProjectSnapshotInput,
    ctx: ProjectOperationContext
  ): Promise<ProjectSnapshotCapture> {
    return this.guarded(ctx, false, () => this.snapshots.capture(input, ctx))
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

  public select(
    input: ProjectSelectInput,
    ctx: ProjectOperationContext
  ): Promise<ProjectSelectResult> {
    return this.guarded(ctx, false, () => selectSources(input, ctx))
  }

  public patch(
    input: ProjectPatchInput,
    ctx: ProjectOperationContext
  ): Promise<ProjectPatchResult> {
    return this.guarded(ctx, true, async () => {
      const result = await patchSelections(input, ctx)
      ctx.recordWriteOutcome?.(
        result.status === 'applied' && result.changed ? 'applied' : 'not-applied'
      )
      return result
    })
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
        kernel.rollback({ transactionId }, ctx.abortSignal)
      )
      return {
        changeRef,
        changedFiles: rolled.changedFiles,
        notes: optionalWhen(rolled.notes?.length, rolled.notes),
      }
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
