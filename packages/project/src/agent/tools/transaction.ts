import { isEmpty, isPlainObject, isString, Log, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ProjectError } from '../../errors'
import type { PrepareEditInput } from '../../types/edit'
import { presentProjectContextSnapshot, type ProjectSourceWindow } from '../presentation/source-window'
import { runWithProjectExecutionGate } from '../ProjectExecutionGate'
import { changedFileContextRanges, committedFileContextSnapshots, registerProjectFileContext } from '../ProjectFileContext'
import type { ProjectToolContext } from '../Types'

import { saveProjectReceipt } from './receipts'
import { projectTransactionHasChanges } from './transaction-result'

export async function applyProjectEditTransaction(
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
  if (!authorization.approved)
    return {
      approved: false,
      changed: false,
      message: authorization.rejectionMessage ?? authorization.message,
    }

  return context.project.runInDirectory(authorization.rootPath, async () =>
    context.project.runWithApproval(() =>
      runWithProjectExecutionGate(
        context.project.getRootPath(),
        true,
        context.abortSignal,
        async () => {
          const kernel = await context.project.kernel()
          const fileContext = registerProjectFileContext(context)
          const notApplied = (error: unknown): never => {
            if (error instanceof ProjectError)
              throw new ProjectError(
                error.reason,
                error.message,
                { ...error.details, executionOutcome: 'not-applied' },
                error.suggestedNextAction
              )
            const failure = AppError.from(error)
            throw new AppError(failure.code, failure.message, error, {
              ...failure.context,
              executionOutcome: 'not-applied',
            })
          }
          const plan = await Promise.resolve()
            .then(async (): Promise<PrepareEditInput> => input.plan ? input.plan() : {
              operations: input.operations ?? [],
              baseRevisions: input.baseRevisions,
            })
            .catch(notApplied)
          // 计划没有产生任何写入（例如所有文件已是目标编码）时不开事务，直接回执。
          if (isEmpty(plan.operations))
            return {
              approved: true,
              changed: false,
              changedFiles: [],
              recode: optionalWhen(isPlainObject, plan.metadata?.recode),
              message: '没有需要写入的文件。',
            }
          const transaction = await kernel.prepareEdit(plan).catch(notApplied)
          try {
            const applied = await kernel.applyEdit({ transactionId: transaction.transactionId })
            const finalTransaction = kernel.getTransaction(transaction.transactionId) ?? transaction
            let contextRefreshError: string | undefined
            try {
              fileContext?.touch(
                context.project.getRootPath(),
                applied.changedFiles,
                changedFileContextRanges(finalTransaction.patches)
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
