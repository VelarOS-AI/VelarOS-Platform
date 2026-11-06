/**
 * 项目文件能力（`velaros:project`）的操作：`ProjectFileOperations` 与整个进程唯一的 `projectFileOperations`。接口 `ProjectFileOperationsApi` 在本文件的类上方。
 * 读操作在项目资源门的读门里跑（彼此并行、与写互斥）；改动在写门里跑：规划 → 内核准备、校验、提交，撤销同样。不问用户。
 * 校验与撤销账本都在项目内核里，这里只负责把模型的步骤编成事务、把结果写成模型面的样子。
 */
import { isString, optionalWhen } from '@velaros-ai/core'

import type { ProjectOperationContext } from '../../contract/requires.js'
import type {
  ProjectChangeInput,
  ProjectChangeInspection,
  ProjectCommitInput,
  ProjectCommitResult,
  ProjectEditInput,
  ProjectEditResult,
  ProjectInspectInput,
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
import { commitFiles, inspectedDiff, resolveCommit } from '../../utils/agent/commit.js'
import { commitProjectEdit } from '../../utils/agent/edit-commit.js'
import { editInput } from '../../utils/agent/file-input.js'
import { listEntries, readFiles, searchFiles } from '../../utils/agent/file-reads.js'
import { planPathSteps } from '../../utils/agent/path-steps.js'
import { projectFailure } from '../../utils/agent/ports.js'
import { resolveProjectContext } from '../../utils/agent/project-routing.js'
import { patchSelections } from '../../utils/agent/selection-patch.js'
import { selectSources } from '../../utils/agent/selection-reads.js'
import { beforeWrite } from '../../utils/transactions/transaction-errors.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'
import { ProjectSnapshotCollector } from './ProjectSnapshotCollector.js'

/**
 * @AgentView
 * 用 Node 读、找和转换文件。项目改动用一次 commit；路径相对同一个项目根，projectRoot 可请求宿主授权的其他根。
 * 唯一片段直接提交；全文使用已读基线和新内容。检查此次写入先看回执，需要更多差量用 inspect；撤回用 undo。
 * 外层程序失败时先 inspect 查询持久状态。snapshot 供固定的只读观察计划使用。
 */
export interface ProjectFileOperationsCommitApi {
  /** @AgentView 以一次事务提交 changes。唯一片段无需预读；全文使用同一次读取的 before，after 给 JS 计算的新文本。回执返回紧凑差量，重试同一 requestId 可查原结果。
   * @OperationEffect write
   * @OperationModes execute
   */
  commit(input: ProjectCommitInput, ctx: ProjectOperationContext): Promise<ProjectCommitResult>
  /** @AgentView 捕获声明式 files 纯快照计划：最多 20 个文件、每次捕获 500000 个字符；在同一项目读门内前后完整读取，任何缺失、截断或前后变化都失败。快照只证明此次捕获值相同，不能证明读取期间没有 ABA，也不授予后续写入或跳过 IO。
   * @OperationEffect none
   */
  snapshot(
    input: ProjectSnapshotInput,
    ctx: ProjectOperationContext
  ): Promise<ProjectSnapshotCapture>
  /** @AgentView 看一次改动的差量与状态。
   * @OperationEffect none
   */
  inspect(
    input: ProjectInspectInput,
    ctx: ProjectOperationContext
  ): Promise<ProjectChangeInspection>
  /** @AgentView 整次撤销一次改动：写回原文、删掉它新建的文件。
   * @OperationEffect write
   */
  undo(input: ProjectChangeInput, ctx: ProjectOperationContext): Promise<ProjectUndoResult>
}

/** 宿主文件浏览、历史编辑器与兼容调用仍可借这些服务；生成的模型合同只取事务和证据接口。 */
export interface ProjectFileOperationsApi extends ProjectFileOperationsCommitApi {
  /** 宿主读取有界文本窗口。 */
  read(input: ProjectReadInput, ctx: ProjectOperationContext): Promise<ProjectReadResult>
  /** 宿主列举符合策略的目录条目。 */
  list(input: ProjectListInput, ctx: ProjectOperationContext): Promise<ProjectListResult>
  /** 宿主搜索源码与上下文。 */
  search(input: ProjectSearchInput, ctx: ProjectOperationContext): Promise<ProjectSearchResult>
  /** 为宿主编辑器定位文本或结构目标。 */
  select(input: ProjectSelectInput, ctx: ProjectOperationContext): Promise<ProjectSelectResult>
  /** 提交宿主已定位的目标编辑。 */
  patch(input: ProjectPatchInput, ctx: ProjectOperationContext): Promise<ProjectPatchResult>
  /** 将旧宿主的有序编辑步骤交给事务内核。 */
  edit(input: ProjectEditInput, ctx: ProjectOperationContext): Promise<ProjectEditResult>
}

export class ProjectFileOperations implements ProjectFileOperationsApi {
  private readonly snapshots = new ProjectSnapshotCollector()
  constructor(private readonly gate: ProjectExecutionGateApi) {}

  public async commit(
    input: ProjectCommitInput,
    context: ProjectOperationContext
  ): Promise<ProjectCommitResult> {
    const ctx = await beforeWrite(() => resolveProjectContext(input, context, true))
    return this.guarded(ctx, true, () => commitFiles(input, ctx))
  }

  public async read(
    input: ProjectReadInput,
    context: ProjectOperationContext
  ): Promise<ProjectReadResult> {
    const ctx = await resolveProjectContext(input, context, false)

    return this.guarded(ctx, false, () => readFiles(input, ctx))
  }

  public async snapshot(
    input: ProjectSnapshotInput,
    context: ProjectOperationContext
  ): Promise<ProjectSnapshotCapture> {
    const ctx = await resolveProjectContext(input, context, false)

    return this.guarded(ctx, false, () => this.snapshots.capture(input, ctx))
  }

  public async list(
    input: ProjectListInput,
    context: ProjectOperationContext
  ): Promise<ProjectListResult> {
    const ctx = await resolveProjectContext(input, context, false)

    return this.guarded(ctx, false, () => listEntries(input, ctx))
  }

  public async search(
    input: ProjectSearchInput,
    context: ProjectOperationContext
  ): Promise<ProjectSearchResult> {
    const ctx = await resolveProjectContext(input, context, false)

    return this.guarded(ctx, false, () => searchFiles(input, ctx))
  }

  public async edit(
    input: ProjectEditInput,
    context: ProjectOperationContext
  ): Promise<ProjectEditResult> {
    const ctx = await beforeWrite(() => resolveProjectContext(input, context, true))

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

  public async select(
    input: ProjectSelectInput,
    context: ProjectOperationContext
  ): Promise<ProjectSelectResult> {
    const ctx = await resolveProjectContext(input, context, false)

    return this.guarded(ctx, false, () => selectSources(input, ctx))
  }

  public async patch(
    input: ProjectPatchInput,
    context: ProjectOperationContext
  ): Promise<ProjectPatchResult> {
    const ctx = await beforeWrite(() => resolveProjectContext(input, context, true))

    return this.guarded(ctx, true, async () => {
      const result = await patchSelections(input, ctx)
      ctx.recordWriteOutcome?.(
        result.status === 'applied' && result.changed ? 'applied' : 'not-applied'
      )
      return result
    })
  }

  public async inspect(
    input: ProjectInspectInput,
    context: ProjectOperationContext
  ): Promise<ProjectChangeInspection> {
    const ctx = await resolveProjectContext(input, context, false)

    try {
      ctx.abortSignal.throwIfAborted()
      const { changeRef, record, transaction, kernel } = await resolveCommit(input, ctx, true)
      const inspected: ProjectChangeInspection = {
        changeRef,
        previousChangeRef: kernel.findCommit?.(
          ctx.sessionId ?? '',
          undefined,
          transaction.transactionId
        )?.transactionId,
        requestId: optionalWhen(
          isString(transaction.metadata?.commitRequest),
          transaction.metadata?.commitRequest as string
        ),
        status: transaction.status,
        changedFiles: transaction.changedFiles,
        ...inspectedDiff(input, transaction),
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
    context: ProjectOperationContext
  ): Promise<ProjectUndoResult> {
    const ctx = await beforeWrite(() => resolveProjectContext(input, context, true))

    try {
      ctx.abortSignal.throwIfAborted()
      return await this.gate.run(ctx.project.getRootPath(), true, ctx.abortSignal, async () => {
        const { changeRef, transaction, kernel } = await beforeWrite(() =>
          resolveCommit(input, ctx, false)
        )
        const transactionId = transaction.transactionId
        // 撤销是幂等的：已经撤销过就如实回执，不报错。
        if (transaction.status === 'rolled_back') {
          ctx.recordWriteOutcome?.('not-applied')
          return { changeRef, changedFiles: transaction.changedFiles, alreadyUndone: true }
        }
        const rolled = await kernel.rollback({ transactionId }, ctx.abortSignal)
        if (rolled.changedFiles.length) {
          ctx.recordProjectCommit?.({
            root: ctx.project.getRootPath(),
            transactionId,
            lifecycle: 'rolled_back',
            changedFiles: rolled.changedFiles,
          })
        }
        ctx.recordWriteOutcome?.(rolled.changedFiles.length ? 'applied' : 'not-applied')
        return {
          changeRef,
          changedFiles: rolled.changedFiles,
          notes: optionalWhen(rolled.notes?.length, rolled.notes),
        }
      })
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
