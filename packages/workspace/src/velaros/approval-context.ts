import { AsyncLocalStorage } from 'node:async_hooks'

import { isEmpty } from '@velaros-ai/core'
import type { ApprovalPort } from '@velaros-ai/core/tool-contract'

import type { ApprovalProvider } from '../types/policy.js'

export interface ApprovalExecutionContext {
  approval: ApprovalPort
  abortSignal: AbortSignal
}

const approvalStore = new AsyncLocalStorage<ApprovalExecutionContext>()

async function withApprovalContext<T>(
  ctx: ApprovalExecutionContext,
  fn: () => Promise<T>
): Promise<T> {
  return approvalStore.run(ctx, fn)
}

function buildDynamicApprovalProvider(): ApprovalProvider {
  return {
    async approve(request) {
      const ctx = approvalStore.getStore()

      // A workspace bridge can be consumed outside Agent Runtime. Without an
      // active host approval scope there is no authority to approve a
      // privileged mutation, so the only safe default is deny.
      if (!ctx) return false

      const riskLabel =
        request.risk === 'high' ? '高风险操作' : '需要审批'
      const pathList =
        request.paths && !isEmpty(request.paths)
          ? `\n${request.paths.map((path) => `  - ${path}`).join('\n')}`
          : ''

      const message = [
        `${riskLabel}: ${request.action}`,
        request.reason ? `原因：${request.reason}` : '',
        pathList,
      ]
        .filter(Boolean)
        .join('\n')

      const decision = await ctx.approval.awaitConfirmationDecision(message, ctx.abortSignal, {
        approvalRisk: request.risk === 'high' ? 'high' : 'low',
        riskScope:
          request.risk === 'high'
            ? `workspace-approval:${request.risk}:${request.action}`
            : undefined,
      })
      return decision.approved
    },
  }
}

function installApprovalProvider(kernel: { providers: { approval?: ApprovalProvider } }): void {
  kernel.providers.approval = buildDynamicApprovalProvider()
}

export { installApprovalProvider, withApprovalContext }
