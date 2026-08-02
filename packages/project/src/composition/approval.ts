import { AsyncLocalStorage } from 'node:async_hooks'

import { isEmpty } from '@velaros-ai/core'
import type { ApprovalPort } from '@velaros-ai/core/tool-contract'

import type { ApprovalProvider } from '../types/policy.js'

interface ProjectApprovalContext {
  approval: ApprovalPort
  abortSignal: AbortSignal
}

const ProjectApprovalStore = new AsyncLocalStorage<ProjectApprovalContext>()

function withProjectApproval<T>(
  context: ProjectApprovalContext,
  action: () => Promise<T>
): Promise<T> {
  return ProjectApprovalStore.run(context, action)
}

function installProjectApprovalProvider(kernel: {
  providers: { approval?: ApprovalProvider }
}): void {
  kernel.providers.approval = {
    async approve(request) {
      const context = ProjectApprovalStore.getStore()
      if (!context) return false

      const paths = request.paths && !isEmpty(request.paths)
        ? `\n${request.paths.map((path) => `  - ${path}`).join('\n')}`
        : ''
      const decision = await context.approval.awaitConfirmationDecision(
        [
          `${request.risk === 'high' ? '高风险项目操作' : '项目操作审批'}：${request.action}`,
          request.reason ? `原因：${request.reason}` : '',
          paths,
        ].filter(Boolean).join('\n'),
        context.abortSignal,
        {
          approvalRisk: request.risk === 'high' ? 'high' : 'low',
          riskScope: `project:${request.risk}:${request.action}`,
        }
      )
      return decision.approved
    },
  }
}

export { installProjectApprovalProvider, withProjectApproval }
export type { ProjectApprovalContext }
