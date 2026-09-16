/**
 * 三个改动操作：`ProjectChangeOperations` 与整个进程唯一的 `projectChangeOperations`。接口 `ProjectChangeOperationsApi` 在本文件的类上方。
 * `project:file`、`project:edit`、`project:change` 各调一个方法。每次改动都先过宿主的项目修改授权，再在项目资源门的写门里开事务、提交、刷新当前文件视图，最后存变更回执。
 */

import { resolve } from 'node:path'

import { isEmpty, isPlainObject, isString, Log, optionalWhen } from '@velaros-ai/core'

import type { ProjectToolContext } from '../../contract/requires.js'
import type { PrepareEditInput } from '../../types/edit.js'
import type { ProjectEditInput, ProjectFileInput } from '../../types/editing.js'
import type { ProjectChangeReceipt } from '../../types/project.js'
import type { ProjectSourceWindow } from '../../types/source-window.js'
import type { ProjectChangeInput } from '../../types/tools.js'
import { withProjectEditRecovery } from '../../utils/agent/edit-recovery.js'
import { changedFileContextRanges, committedFileContextSnapshots, registerProjectFileContext } from '../../utils/agent/file-context.js'
import { projectPlannerResolver } from '../../utils/agent/planner-resolver.js'
import { readProjectReceipt, saveProjectReceipt } from '../../utils/agent/receipts.js'
import { presentProjectContextSnapshot } from '../../utils/agent/source-window.js'
import { projectMutationDenied, projectTransactionHasChanges } from '../../utils/agent/transaction-result.js'
import { compileProjectChange, compileProjectEdit, compileProjectFile } from '../../utils/editing/planner-index.js'
import { ProjectError } from '../../utils/errors.js'
import { plannedFilePaths } from '../../utils/transactions/edit-intents.js'
import { rethrowNotApplied } from '../../utils/transactions/transaction-errors.js'
import { ProjectTuning } from '../../utils/tuning.js'
import { projectApprovalBridge } from '../kernel/ProjectApprovalBridge.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'

/**
 * 三个改动操作：文件动作、源码编辑、组合变更与撤销。改动一律经事务提交：先过宿主的项目修改授权（被拒就一个文件都不写），
 * 再在写门里准备、应用；提交后刷新当前文件视图并归档提交快照，回执带 changeRef，可以凭它 inspect 或 undo。
 */
export interface ProjectChangeOperationsApi {
  /** 文件动作：create、overwrite、move、delete、recode，按顺序编进一个事务一起提交。 */
  file(input: ProjectFileInput, ctx: ProjectToolContext): Promise<Awaited<ReturnType<ProjectChangeOperations['file']>>>
  /** 源码编辑：每个文件凭 fileRef 定位，按 range 或 match 替换、插入，多个文件同一事务；版本过期时尽量给出可确认的新位置。 */
  edit(input: ProjectEditInput, ctx: ProjectToolContext): Promise<Awaited<ReturnType<ProjectChangeOperations['edit']>>>
  /** 组合变更：apply 把文件动作与编辑按步骤编进一个事务；inspect 凭 changeRef 看差量；undo 凭 changeRef 撤销（外部改过就拒绝覆盖）。 */
  change(input: ProjectChangeInput, ctx: ProjectToolContext): Promise<unknown>
}

export class ProjectChangeOperations implements ProjectChangeOperationsApi {
  constructor(private readonly gate: ProjectExecutionGateApi) {}

  public file(input: ProjectFileInput, context: ProjectToolContext) {
    return this.applyTransaction({
      operationLabel: '变更项目文件',
      plan: () => compileProjectFile(input, projectPlannerResolver(context)),
    }, context)
  }

  public edit(input: ProjectEditInput, context: ProjectToolContext) {
    return this.applyTransaction({
      operationLabel: '编辑项目源码',
      plan: () => withProjectEditRecovery(input, context, () => compileProjectEdit(input, projectPlannerResolver(context))),
    }, context)
  }

  public async change(input: ProjectChangeInput, context: ProjectToolContext) {
    if (input.action === 'apply') return this.applyTransaction({
      operationLabel: '项目事务变更',
      // 来源互斥关系已通过 schema 校验，Zod 无法自动推导对应联合类型。
      plan: () => compileProjectChange({ action: 'apply', steps: input.steps! }, projectPlannerResolver(context)),
    }, context)
    context.abortSignal.throwIfAborted()
    const changeRef = input.changeRef!
    // 回执解析失败时什么都没做：标成未执行，模型可以只改 changeRef 重试。
    const record = changeRef.startsWith('change:')
      ? await readProjectReceipt(context, 'change', changeRef).catch(rethrowNotApplied) as {
        transactionId: string
        oldRevisions?: Record<string, string>
        newRevisions?: Record<string, string>
      }
      : { transactionId: changeRef }
    const kernel = await context.project.kernel()
    const transaction = kernel.getTransaction(record.transactionId)
    if (!transaction)
      throw new ProjectError('TARGET_NOT_FOUND', '变更回执当前不可用。', { changeRef, executionOutcome: 'not-applied' },
        'changeRef 只能原样复制本会话 edit/file/change 成功回执里的值。')
    if (input.action === 'inspect') {
      const diff = transaction.diff.slice(0, ProjectTuning.transactions.receiptDiffChars)
      return { changeRef, transactionId: transaction.transactionId, status: transaction.status,
        oldRevisions: record.oldRevisions,
        newRevisions: record.newRevisions,
        changedFiles: transaction.changedFiles, changedLines: transaction.changedLines,
        diff, diffTruncated: diff.length < transaction.diff.length,
      }
    }
    // 撤销是幂等的：已经撤销过就直接如实回执，不再问一次用户、也不报错。
    if (transaction.status === 'rolled_back')
      return {
        changeRef, transactionId: transaction.transactionId, status: 'rolled_back', alreadyUndone: true,
        changedFiles: transaction.changedFiles, message: '这次改动已经撤销过，不用再撤销。',
      }
    const authorization = await context.project.prepareMutation({ operation: '撤销项目变更', paths: [...transaction.changedFiles] })
    if (!authorization.approved) throw projectMutationDenied(authorization)
    return projectApprovalBridge.run({ approval: context.approval, abortSignal: context.abortSignal }, () => this.gate.run(
      context.project.getRootPath(), true, context.abortSignal, async () => {
        const files = registerProjectFileContext(context)
        try {
          const result = await kernel.rollback({ transactionId: record.transactionId })
          return { ...result, changeRef }
        } finally {
          files?.touch(context.project.getRootPath(), transaction.changedFiles)
          await files?.prepare(context.toolCallId)
        }
      },
    ))
  }

  /**
   * 按计划开一个事务并提交：先在写门里规划（纯计算，不写盘），带着这次要写的路径过项目的修改授权，再准备、应用、刷新当前文件视图、存变更回执；
   * 计划没有写入时不开事务。失败时丢弃事务并如实报未执行。
   */
  private async applyTransaction(
    input: {
      operations?: PrepareEditInput['operations']
      plan?: () => Promise<PrepareEditInput>
      operationLabel: string
      baseRevisions?: Record<string, string>
    },
    context: ProjectToolContext
  ) {
    context.abortSignal.throwIfAborted()
    return projectApprovalBridge.run({ approval: context.approval, abortSignal: context.abortSignal }, () =>
      this.gate.run(
          context.project.getRootPath(),
          true,
          context.abortSignal,
          async () => {
            const kernel = await context.project.kernel()
            const fileContext = registerProjectFileContext(context)
            const plan = await Promise.resolve()
              .then(async (): Promise<PrepareEditInput> => input.plan ? input.plan() : {
                operations: input.operations ?? [],
                baseRevisions: input.baseRevisions,
              })
              .catch(rethrowNotApplied)
            // 计划没有产生任何写入（例如所有文件已是目标编码）时不开事务，也不打扰用户。
            if (isEmpty(plan.operations))
              return {
                approved: true,
                changed: false,
                changedFiles: [],
                recode: optionalWhen(isPlainObject, plan.metadata?.recode),
                message: '没有需要写入的文件。',
              }
            // 规划之后、开事务之前问授权：确认卡片能列出这次会写哪些文件，被拒时一个字节都没写。
            const authorization = await context.project.prepareMutation({
              operation: input.operationLabel,
              paths: plannedFilePaths(plan.operations),
            })
            if (!authorization.approved) throw projectMutationDenied(authorization)
            const transaction = await kernel.prepareEdit(plan).catch(rethrowNotApplied)
            try {
              const applied = await kernel.applyEdit({ transactionId: transaction.transactionId })
              const finalTransaction = kernel.getTransaction(transaction.transactionId) ?? transaction
              let contextRefreshError: string | undefined
              try {
                const root = resolve(context.project.getRootPath())
                const previousRanges = Object.fromEntries((fileContext?.currentViews() ?? [])
                  .filter((view) => view.workspaceId === root)
                  .map((view) => [view.path, view.ranges]))
                fileContext?.touch(
                  context.project.getRootPath(),
                  applied.changedFiles,
                  changedFileContextRanges(finalTransaction.patches, previousRanges)
                )
                try {
                  if (fileContext && kernel.prepareContextSnapshot) {
                    for (const snapshot of committedFileContextSnapshots(
                      context.project.getRootPath(),
                      finalTransaction.patches,
                      applied.oldRevisions,
                      applied.newRevisions
                    )) {
                      const filtered = await kernel.prepareContextSnapshot({
                        path: snapshot.path,
                        content: snapshot.content,
                      })
                      await fileContext.archive([{ ...snapshot, ...filtered }], context.toolCallId)
                    }
                  }
                } catch (error) {
                  contextRefreshError = String(error)
                  Log.tag('ProjectTransaction').warn('archive_context_failed', { error: contextRefreshError })
                }
                for (const patch of finalTransaction.patches) {
                  const from = patch.metadata?.from
                  if (
                    patch.metadata?.op === 'rename_file_create' &&
                    isString(from) &&
                    applied.oldRevisions[from] &&
                    applied.newRevisions[patch.path]
                  ) {
                    await fileContext?.recordRename(
                      context.project.getRootPath(),
                      from,
                      patch.path,
                      applied.oldRevisions[from],
                      applied.newRevisions[patch.path]
                    )
                  }
                }
                await fileContext?.prepare(context.toolCallId)
              } catch (error) {
                contextRefreshError = String(error)
                Log.tag('ProjectTransaction').warn('refresh_context_failed', { error: contextRefreshError })
              }
              const notes = finalTransaction.patches
                .map((patch) => patch.metadata?.matchNote)
                .filter(isString)
              const files: ProjectSourceWindow[] = []
              try {
                for (const view of fileContext?.currentViews() ?? []) {
                  if (!applied.changedFiles.includes(view.path)) continue
                  for (const snapshot of view.snapshots)
                    files.push(await presentProjectContextSnapshot(context, snapshot))
                }
              } catch (error) {
                contextRefreshError = String(error)
                Log.tag('ProjectTransaction').warn('present_context_failed', { error: contextRefreshError })
              }
              const changeRef = await saveProjectReceipt(context, 'change', {
                transactionId: transaction.transactionId,
                oldRevisions: applied.oldRevisions,
                newRevisions: applied.newRevisions,
              }).catch((error: unknown) => {
                Log.tag('ProjectTransaction').warn('save_change_receipt_failed', { error: String(error) })
                return undefined
              })
              // 宿主界面按这几个字段画改动摘要（合同在 types/project.ts 的 ProjectChangeReceipt），
              // 字段名与内核 ApplyResult 一致：读结果过期判断、「已编辑」统计和改动摘要都按 newRevisions 读，
              // 新建的文件靠「不在 oldRevisions 里」认出来；以前这里叫 revisions，那几处全都读空。
              const receipt: ProjectChangeReceipt = {
                changeRef: changeRef ?? transaction.transactionId,
                transactionId: transaction.transactionId,
                changed: projectTransactionHasChanges(finalTransaction.patches),
                changedFiles: applied.changedFiles,
                oldRevisions: applied.oldRevisions,
                newRevisions: applied.newRevisions,
              }
              const diff = finalTransaction.diff.slice(0, ProjectTuning.transactions.receiptDiffChars)
              return {
                ...receipt,
                contextRefreshError,
                files,
                diff,
                diffTruncated: diff.length < finalTransaction.diff.length,
                diffLines: finalTransaction.changedLines,
                notes: optionalWhen(!isEmpty(notes), notes),
                recode: optionalWhen(isPlainObject, transaction.metadata?.recode),
              }
            } catch (error) {
              fileContext?.touch(context.project.getRootPath(), transaction.changedFiles)
              kernel.discardTransaction(transaction.transactionId)
              throw error
            }
          }
        )
    )
  }
}

/** 整个进程唯一的改动操作；三个改动工具的 execute 交给它。 */
export const projectChangeOperations: ProjectChangeOperationsApi = new ProjectChangeOperations(projectExecutionGate)
