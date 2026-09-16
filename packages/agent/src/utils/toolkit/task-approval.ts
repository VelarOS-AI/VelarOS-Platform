import { isFalse } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { toolIdentity } from '@velaros-ai/tool-contract'

import type { ApprovalPort } from '../../contract/requires.js'
import type { ApprovalDecision, ToolConfirmationDecisionOptions } from '../../types/agent'
import type { ApprovalSession } from '../../types/toolkit.js'

/** 参数身份保留完整值和确定顺序；只用于内部比较，不作为界面预览。 */
export function createApprovalOperationKey(kind: string, value: unknown): string {
  return toolIdentity.approvalOperationKey(kind, value)
}

/** 两种旧确认入口共用一条串行通道，任务拒绝优先于自动批准，拒绝只终止当前操作。 */
export function createTaskApprovalPort(
  delegate: ApprovalPort,
  session: ApprovalSession,
  policy: {
    shouldAutoApprove(options: ToolConfirmationDecisionOptions): boolean
    rejectionReason?(options: ToolConfirmationDecisionOptions): Nullable<string>
  }
): ApprovalPort {
  let queue: Promise<unknown> = Promise.resolve()
  const decide = (
    message: string,
    signal?: AbortSignal,
    options: ToolConfirmationDecisionOptions = {}
  ): Promise<ApprovalDecision> => {
    const key = options.operation?.key ?? options.riskScope ?? `confirmation:${message.trim()}`
    const scopedOptions = {
      ...options,
      riskScope: key,
      operation: options.operation ?? { key, label: message.slice(0, 600) },
    }
    const run = async (): Promise<ApprovalDecision> => {
      signal?.throwIfAborted()
      const denial = session.getTaskApprovalDenial?.(key)
      if (denial) return { approved: false, message: denial, previouslyDenied: true }
      const rejection = policy.rejectionReason?.(scopedOptions)
      if (rejection) return { approved: false, message: rejection, autoApproved: false }
      if (policy.shouldAutoApprove(scopedOptions)) return { approved: true, message: null, autoApproved: true }
      session.recordConfirmationCard?.()
      const result = await delegate.awaitConfirmationDecision(message, signal, {
        ...scopedOptions,
        detail: {
          ...(options.detail ?? { kind: 'operation-authorization' }),
          authorization: {
            label: scopedOptions.operation.label,
            target: scopedOptions.operation.target,
            requester: options.requester?.label ?? options.requester?.agentId,
            scope: options.requireManualApproval || isFalse(options.rememberRiskScope)
              ? 'call' : 'task-operation',
          },
        },
      })
      signal?.throwIfAborted()
      if (!result.approved || (!options.requireManualApproval && !isFalse(options.rememberRiskScope))) {
        if (session.recordTaskApproval) {
          session.recordTaskApproval(key, result.approved, scopedOptions, result.message)
        } else if (result.approved) {
          session.grantConfirmedRiskScope?.(key)
        }
      }
      return result
    }
    const result = queue.then(run, run)
    queue = result.then(() => undefined, () => undefined)
    if (!signal) return result
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = (): void => reject(new AppError('EXECUTION_ABORTED', '运行被终止'))
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
      result.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }
  return {
    awaitConfirmationDecision: decide,
    awaitConfirmation: async (message, signal, options) => {
      const result = await decide(message, signal, options)
      if (!result.approved) throw new AppError('EXECUTION_DENIED',
        result.message ?? '用户拒绝了本次操作。请选择其他方案。')
    },
  }
}
