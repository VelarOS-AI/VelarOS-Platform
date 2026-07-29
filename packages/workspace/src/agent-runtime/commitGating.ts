/**
 * commit_edit 门控与编排：从 Kernel.tool 抽离，统一 needs_model_review 语义。
 */
import { isEmpty, Log } from '@velaros-ai/core'
import { optionalWhen } from '@velaros-ai/core/utils/optionalWhen'

import type {
  CommitEditPreparedGroup,
  TransactionDiffBudgetAssessment,
  WorkspaceCommitEditInput,
} from './KernelToolShared'
import {
  assessTransactionDiffBudget,
  augmentPrepareEditSnapshotHints,
  augmentRevisionMismatchMessage,
  buildModelReviewResult,
  flattenApplyResult,
  modelVisibleErrorDiagnostic,
  modelVisibleErrorMessage,
  resolveCommitValidationChecks,
  splitCommitOperations,
  summarizeCommitGroup,
  summarizePreparedTransaction,
  transactionPreflightAdvisories,
  transactionRequiresModelReview,
  uniqueValues,
  wsTool,
} from './KernelToolShared'
import { attachSystemToolSuggestion } from './ToolRequirements'
import type { WorkspaceToolContext } from './Types'
import {
  type AgentWorkspaceApplyResult,
  type AgentWorkspaceFixResult,
  type AgentWorkspaceKernelPort,
  type AgentWorkspacePreparedTransaction,
  type AgentWorkspaceValidationResult,
  isAgentWorkspaceError,
  toAgentWorkspaceErrorObject,
} from './WorkspaceCapabilityPort'

export interface ExecuteCommitEditOptions {
  kernel: AgentWorkspaceKernelPort
  ctx: WorkspaceToolContext
  input: WorkspaceCommitEditInput
  shouldAutoApply: boolean
  shouldAutoFix: boolean
  splitMode: NonNullable<WorkspaceCommitEditInput['split']>
}

/**
 * 把「超编辑预算」的事务汇总成给模型的结构化拆分指引：哪些事务超额、建议按文件还是按
 * hunk 分批、以及「在 plan 里维护已提交 / 待提交清单」的收尾约束。
 */
function buildEditBudgetGuidance(
  overBudget: Array<{ group: CommitEditPreparedGroup; assessment: TransactionDiffBudgetAssessment }>
) {
  const usedFallbackWindow = overBudget.some((entry) => entry.assessment.usedFallbackWindow)
  const overflowingTransactions = overBudget.map(({ group, assessment }) => ({
    transactionId: group.tx.transactionId,
    estimatedTokens: assessment.estimatedTokens,
    budgetTokens: assessment.budgetTokens,
    usableContextWindowTokens: assessment.usableContextWindowTokens,
    fileCount: assessment.fileCount,
    suggestedSplit: assessment.fileCount > 1 ? ('file' as const) : ('hunk' as const),
    largestFilePath: assessment.largestFilePath,
    largestFileChangedLines: assessment.largestFileChangedLines,
  }))
  return {
    reason: 'diff-token-budget' as const,
    usedFallbackWindow,
    overflowingTransactions,
    nextActions: [
      '把这次大改拆成多次较小的 commit_edit：多文件用 split: "file"，单个超大文件按 hunk / 子区域分多次编辑。',
      '用 update_plan 维护一份「已提交 / 待提交」清单：每提交完一批就勾掉，剩余批次留在 plan 里，确保不丢改也不重复。',
      '确无法拆分（例如必须原子提交）时，再带 confirmRisk: true 重试；但巨型 diff 会显著加大上下文与反复风险。',
    ],
  }
}

/** 一步提交编辑：准备 → 校验（可选 autoFix）→ 门控审核 → 应用（失败时多事务回滚）。 */
export async function executeCommitEditWithGating(options: ExecuteCommitEditOptions) {
  const { kernel, ctx, input, shouldAutoApply, shouldAutoFix, splitMode } = options
  const { checks, postconditions, ...prepareInput } = input

  // 空 operations 是无意义调用，且极易是模型误把「空 operations + confirmRisk」当成「确认上一次
  // needs_model_review」——但本工具是无状态的，不保留上一次的待提交事务，空提交会静默写不了盘。
  // 明确拦截并把正确恢复路径告诉模型，而不是返回一个 changed:true 的幻影成功。
  if (prepareInput.operations.length === 0) return buildModelReviewResult(wsTool.commitEdit, ['operations 为空：没有任何编辑操作可提交。'], {
      changedFiles: [],
      changedLines: 0,
      message:
        `operations 为空，工具没有写盘。${wsTool.edit}/${wsTool.commitEdit} 是无状态的：它不会保留上一次 needs_model_review 的待提交事务。要写盘，请带上**相同的 operations** 再次调用，并加 confirmRisk: true。`,
      nextActions: [
        `确认上次 diff 无误后：用与上次**完全相同的 operations** 加 confirmRisk: true 重新调用 ${wsTool.edit} 即可写盘。`,
        '不要用空 operations「确认」上一次的审核——那不会提交任何东西。',
      ],
    })

  const { checks: validationChecks, deferredFinalizerChecks } =
    await resolveCommitValidationChecks(kernel, checks)
  const pendingGroups = splitCommitOperations(prepareInput.operations, splitMode)
  const preparedGroups: CommitEditPreparedGroup[] = []

  for (let index = 0; index < pendingGroups.length; index += 1) {
    const group = pendingGroups[index]
    let tx: AgentWorkspacePreparedTransaction
    try {
      tx = await kernel.prepareEdit({
        ...prepareInput,
        operations: group.operations,
      })
    } catch (error) {
      if (
        splitMode === 'auto' &&
        group.operations.length > 1 &&
        isAgentWorkspaceError(error, 'SCOPE_VIOLATION')
      ) {
        pendingGroups.splice(
          index,
          1,
          ...group.operations.map((operation, operationIndex) => ({
            groupId: `${group.groupId}:operation:${operationIndex}`,
            operations: [operation],
          }))
        )
        index -= 1
        continue
      }
      if (isAgentWorkspaceError(error, 'SCOPE_VIOLATION')) return buildModelReviewResult(wsTool.commitEdit, [error.message], {
          failedGroupId: group.groupId,
          error: { reason: error.reason, message: error.message, details: error.details },
        })
      augmentRevisionMismatchMessage(error)
      augmentPrepareEditSnapshotHints(error)
      return buildModelReviewResult(wsTool.commitEdit, [modelVisibleErrorMessage(error)], {
        failedGroupId: group.groupId,
        error: toAgentWorkspaceErrorObject(error),
        diagnostics: [modelVisibleErrorDiagnostic(`${wsTool.commitEdit}.prepare`, error)],
      })
    }

    let validation: AgentWorkspaceValidationResult
    let fix: AgentWorkspaceFixResult | undefined
    try {
      validation = await attachSystemToolSuggestion(
        await kernel.validate({
          transactionId: tx.transactionId,
          checks: validationChecks,
          postconditions,
        }),
        ctx
      )
      if (!validation.ok && shouldAutoFix) {
        fix = await attachSystemToolSuggestion(
          await kernel.fixTransaction({
            transactionId: tx.transactionId,
            checks: validationChecks,
            maxPasses: 2,
          }),
          ctx
        )
        if (fix.changed) {
          validation = await attachSystemToolSuggestion(
            await kernel.validate({
              transactionId: tx.transactionId,
              checks: validationChecks,
              postconditions,
            }),
            ctx
          )
        }
      }
    } catch (error) {
      augmentRevisionMismatchMessage(error)
      return buildModelReviewResult(wsTool.commitEdit, [modelVisibleErrorMessage(error)], {
        failedGroupId: group.groupId,
        transactionId: tx.transactionId,
        prepared: summarizePreparedTransaction(tx),
        error: toAgentWorkspaceErrorObject(error),
        diagnostics: [modelVisibleErrorDiagnostic(`${wsTool.commitEdit}.validate`, error)],
      })
    }
    preparedGroups.push({
      groupId: group.groupId,
      operations: group.operations,
      tx,
      validation,
      fix,
    })
  }

  const transactionSummaries = preparedGroups.map(summarizeCommitGroup)
  const changedFiles = uniqueValues(preparedGroups.flatMap((group) => group.tx.changedFiles))
  const changedLines = preparedGroups.reduce((sum, group) => sum + group.tx.changedLines, 0)
  const risk = preparedGroups.some((group) => group.tx.risk === 'high')
    ? 'high'
    : preparedGroups.some((group) => group.tx.risk === 'medium')
      ? 'medium'
      : 'low'
  const baseResult = {
    transactionId: optionalWhen(preparedGroups.length === 1, preparedGroups[0]?.tx.transactionId),
    transactionIds: preparedGroups.map((group) => group.tx.transactionId),
    changedFiles,
    changedLines,
    risk,
    transactions: transactionSummaries,
    prepared: optionalWhen(preparedGroups.length === 1, transactionSummaries[0]?.prepared),
    validation: optionalWhen(preparedGroups.length === 1, transactionSummaries[0]?.validation),
    ...(deferredFinalizerChecks.length > 0
      ? {
          deferredFinalizerChecks,
          finalizerNote:
            'commit_edit 默认跳过 Prettier/ESLint；这些检查应在最终整理阶段运行，或显式通过 checks 请求。',
        }
      : {}),
  }

  const failedGroups = preparedGroups.filter((group) => !group.validation.ok)
  if (!isEmpty(failedGroups)) return buildModelReviewResult(
      wsTool.commitEdit,
      failedGroups.map((group) => `子事务 ${group.tx.transactionId} 校验失败`),
      {
        ...baseResult,
        failedTransactions: failedGroups.map(summarizeCommitGroup),
      }
    )

  if (!shouldAutoApply) return {
      ...baseResult,
      status: 'validated' as const,
      changed: false,
      applied: false,
    }

  // 上下文感知的编辑预算：用本轮模型可用窗口（agent loop 下发到 coding session）评估 diff 体量。
  const usableContextWindowTokens = ctx.codingSession.getUsableContextWindowTokens?.()
  const diffBudgetAssessments = preparedGroups.map((group) => ({
    group,
    assessment: assessTransactionDiffBudget(group.tx, usableContextWindowTokens),
  }))
  const overBudget = diffBudgetAssessments.filter((entry) => entry.assessment.exceeded)

  const reviewReasons = preparedGroups.flatMap((group) => [
    ...transactionRequiresModelReview(group.tx, group.operations, { usableContextWindowTokens }),
    ...transactionPreflightAdvisories(group.tx).map((advisory) => advisory.message),
  ])
  if (!isEmpty(reviewReasons) && !input.confirmRisk) return buildModelReviewResult(wsTool.commitEdit, uniqueValues(reviewReasons), {
      ...baseResult,
      editBudget: optionalWhen(!isEmpty(overBudget), buildEditBudgetGuidance(overBudget)),
      // 纯风险/建议类审核（非超预算、非校验失败）：diff 已备好并通过校验，模型只需带**相同的
      // operations** 加 confirmRisk 重提交即可写盘。默认文案偏向 amend/拆小，会误导模型用空
      // operations 去「确认」，所以这里覆盖成明确的 confirmRisk 重提交指引。
      ...(isEmpty(overBudget)
        ? {
            message:
              `本次编辑已通过校验，仅因风险需要模型确认；工具尚未写盘。确认 diff 无误后，用**相同的 operations** 加 confirmRisk: true 重新调用 ${wsTool.edit} 即可写盘。`,
            nextActions: [
              `确认无误：用与本次**完全相同的 operations** 加 confirmRisk: true 重新调用 ${wsTool.edit}（不要用空 operations，空 operations 不会提交任何东西）。`,
              '需要改动：调整 operations 后重新提交。',
              `需要人工分步审阅：改用 ${wsTool.prepareEdit} → ${wsTool.diff}/${wsTool.validate} → ${wsTool.applyEdit}。`,
            ],
          }
        : {}),
    })

  const applyResults: AgentWorkspaceApplyResult[] = []
  try {
    for (const group of preparedGroups) {
      const applyResult = await ctx.workspace.runWithApproval(
        () => kernel.applyEdit({ transactionId: group.tx.transactionId })
      )
      applyResults.push(applyResult)
    }

    if (applyResults.length === 1 && preparedGroups[0]) {
      const [applyResult] = applyResults
      return {
        ...baseResult,
        ...flattenApplyResult(applyResult),
        status: 'applied' as const,
        changed: true,
        applied: true,
        apply: applyResult,
      }
    }

    return {
      ...baseResult,
      oldRevisions: Object.assign({}, ...applyResults.map((result) => result.oldRevisions)),
      newRevisions: Object.assign({}, ...applyResults.map((result) => result.newRevisions)),
      status: 'applied' as const,
      changed: true,
      applied: true,
      applyResults,
    }
  } catch (error) {
    const rolledBackTransactions: string[] = []
    for (const applied of [...applyResults].reverse()) {
      try {
        await kernel.rollback({ transactionId: applied.transactionId })
        rolledBackTransactions.push(applied.transactionId)
      } catch (rollbackError) {
        Log.tag('WorkspaceCommitGating').warn('回滚已应用子事务失败', {
          transactionId: applied.transactionId,
          error: rollbackError,
        })
      }
    }
    if (!isEmpty(rolledBackTransactions) && error instanceof Error) {
      error.message = `${error.message} 已尝试回滚已应用子事务：${rolledBackTransactions.join(', ')}。`
    }
    return buildModelReviewResult(wsTool.commitEdit, [modelVisibleErrorMessage(error)], {
      ...baseResult,
      error: toAgentWorkspaceErrorObject(error),
      diagnostics: [modelVisibleErrorDiagnostic(`${wsTool.commitEdit}.apply`, error)],
      rolledBackTransactions,
      appliedTransactionsBeforeFailure: applyResults.map((result) => result.transactionId),
    })
  }
}
