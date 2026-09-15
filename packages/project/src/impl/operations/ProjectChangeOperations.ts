/**
 * 三个改动操作：`ProjectChangeOperations` 与整个进程唯一的 `projectChangeOperations`。接口 `ProjectChangeOperationsApi` 在本文件的类上方。
 * `project:file`、`project:edit`、`project:change` 各调一个方法。每次改动都先过宿主的项目修改授权，再在项目资源门的写门里开事务、提交、刷新当前文件视图，最后存变更回执。
 */

import { resolve } from 'node:path'

import { isEmpty, isPlainObject, isString, Log, optionalWhen } from '@velaros-ai/core'

import type { ProjectToolContext } from '../../contract/requires.js'
import type { PrepareEditInput } from '../../types/edit.js'
import type { ProjectEditInput, ProjectFileInput } from '../../types/editing.js'
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
import { rethrowNotApplied } from '../../utils/transactions/transaction-errors.js'

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
      const diff = transaction.diff.slice(0, 16_000)
      return { changeRef, transactionId: transaction.transactionId, status: transaction.status,
        oldRevisions: record.oldRevisions,
        newRevisions: record.newRevisions,
        changedFiles: transaction.changedFiles, changedLines: transaction.changedLines,
        diff, diffTruncated: diff.length < transaction.diff.length,
      }
  }
  const authorization = await context.project.prepareMutation({ operation: '撤销项目变更' })
  if (!authorization.approved) throw projectMutationDenied(authorization)
  return context.project.runWithApproval(() => this.gate.run(
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

  /** 按计划开一个事务并提交：先过项目的修改授权，再在写门里准备、应用、刷新当前文件视图、存变更回执；计划没有写入时不开事务。失败时丢弃事务并如实报未执行。 */
    private async applyTransaction(
    input: {
      operations?: PrepareEditInput['operations']
      plan?: () => Promise<PrepareEditInput>
      cwd?: string
      operationLabel: string
      targetPath?: string
      baseRevisions?: Record<string, string>
    },
    context: ProjectToolContext
  ) {
    context.abortSignal.throwIfAborted()
    const authorization = await context.project.prepareMutation({
      cwd: input.cwd,
      operation: input.operationLabel,
      targetPath: input.targetPath,
    })
    if (!authorization.approved) throw projectMutationDenied(authorization)

    return context.project.runInDirectory(authorization.rootPath, async () =>
      context.project.runWithApproval(() =>
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
            // 计划没有产生任何写入（例如所有文件已是目标编码）时不开事务，直接回执。
            if (isEmpty(plan.operations))
              return {
                approved: true,
                changed: false,
                changedFiles: [],
                recode: optionalWhen(isPlainObject, plan.metadata?.recode),
                message: '没有需要写入的文件。',
              }
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
              return {
                changed: projectTransactionHasChanges(finalTransaction.patches),
                contextRefreshError,
                transactionId: transaction.transactionId,
                changeRef: changeRef ?? transaction.transactionId,
                changedFiles: applied.changedFiles,
                // 字段名与内核 ApplyResult 一致：Agent 的读结果过期判断、「已编辑」统计和宿主的改动摘要都按
                // newRevisions 读；以前这里叫 revisions，这几处全都读空。
                newRevisions: applied.newRevisions,
                files,
                diff: finalTransaction.diff.slice(0, 16_000),
                diffTruncated: finalTransaction.diff.length > 16_000,
                changedLines: finalTransaction.changedLines,
                risk: transaction.risk,
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
    )
  }
}

/** 整个进程唯一的改动操作；三个改动工具的 execute 交给它。 */
export const projectChangeOperations: ProjectChangeOperationsApi = new ProjectChangeOperations(projectExecutionGate)
