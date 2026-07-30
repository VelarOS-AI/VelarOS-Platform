/**
 * 域：`ws_edit` 单入口的门控与编排——模型的一次调用 → 内核多轮事务协议之间的**唯一**翻译层。
 *
 * ## 跨层接缝：谁拥有什么
 * 模型侧只看到"一步写盘"。真正的 prepare → validate → (autoFix) → apply 四段协议在这里跑完；
 * 分步事务工具（ws_prepare_edit / ws_apply_edit）已从模型面移除，所以**这里是模型能触达内核
 * 事务机的全部路径**。往这里加旁路 = 绕过下面所有门。
 *
 * ## 顺序契约（谁必须早于谁）
 *   拆分(split) → prepare → validate(+autoFix 后复验) → 预算/风险审核 → 逐组 apply
 * 审核门必须在 apply **之前**：`needs_model_review` 的语义是"没写盘，你确认后再来"。把审核挪到
 * apply 之后 = 模型看到的 diff 已经落盘，确认失去意义。
 *
 * ## 关键不变量（改这些会破什么）
 *  - **本工具无状态**：不保留上一次的待提交事务。所以"确认"必须是**带相同 operations 重发 +
 *    confirmRisk**，不是空 operations 再调一次。空 operations 被显式拦截并给出恢复路径——
 *    否则模型会拿到一个 changed:true 的幻影成功。
 *  - **auto 拆分只在 SCOPE_VIOLATION 上触发，且只降解一级**：多操作组炸了就摊成单操作组重试；
 *    单操作组再炸就如实返回。这保证 `pendingGroups` 的原地改写一定收敛（组只会变小，且长度
 *    为 1 时不再拆）。
 *  - **多组 apply 失败必须逆序回滚已应用组**：一次 ws_edit 在模型眼里是一个原子动作，留下
 *    "前两组写了、第三组没写"是最坏失败模式。回滚本身失败只记账不掩盖原始错误。
 *  - **验证失败 → 不 apply**：`failedGroups` 非空直接返回 review 结果，任何 confirmRisk 都不
 *    绕过校验失败（confirmRisk 只解风险/预算类拦截）。
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
