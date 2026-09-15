/**
 * 项目审批桥：`ProjectApprovalBridge` 与整个进程唯一的 `projectApprovalBridge`。接口 `ProjectApprovalBridgeApi` 在本文件的类上方。
 * 内核遇到要人审的操作时只认 providers.approval；这座桥把它接到「此刻正在执行的那次工具调用」的审批端口上，并发的调用按异步上下文各找各的。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { createApprovalOperationKey } from '@velaros-ai/agent/tool-contract'
import { isEmpty } from '@velaros-ai/core'

import type { ApprovalProvider } from '../../contract/requires.js'
import type { ProjectApprovalContext } from '../../types/agent.js'
import type { ApprovalRequest } from '../../types/policy.js'

/**
 * 项目审批桥：宿主在执行一次工具调用时用 run 标出这次调用的审批端口，并给内核 install 一次审批 provider；
 * 这之后内核发起的审批请求都交给当前那次调用的审批端口，确认卡片列出动作、原因和涉及的路径。不在任何调用里时一律拒绝。
 */
export interface ProjectApprovalBridgeApi {
  /** 在给定的工具审批上下文里执行 action：action 期间内核发起的审批都交给这次调用的审批端口。 */
  run<T>(context: ProjectApprovalContext, action: () => Promise<T>): Promise<T>
  /** 给内核装上审批 provider：审批请求交给当前上下文的审批端口；没有上下文时拒绝。 */
  install(kernel: { providers: { approval?: ApprovalProvider } }): void
}

export class ProjectApprovalBridge implements ProjectApprovalBridgeApi {
  private readonly store = new AsyncLocalStorage<ProjectApprovalContext>()

  public run<T>(context: ProjectApprovalContext, action: () => Promise<T>): Promise<T> {
    return this.store.run(context, action)
  }

  public install(kernel: { providers: { approval?: ApprovalProvider } }): void {
    kernel.providers.approval = { approve: (request) => this.approve(request) }
  }

  /** 把一次内核审批请求交给当前调用的审批端口：高风险的标高风险，操作键按动作与排好序的路径生成，同一操作只问一次。 */
  private async approve(request: ApprovalRequest): Promise<boolean> {
    const context = this.store.getStore()
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
        operation: {
          key: createApprovalOperationKey('project-operation', { action: request.action, paths: [...(request.paths ?? [])].sort() }),
          label: request.action,
          target: request.paths?.join(', '),
        },
      }
    )
    return decision.approved
  }
}

/** 整个进程唯一的项目审批桥。 */
export const projectApprovalBridge: ProjectApprovalBridgeApi = new ProjectApprovalBridge()
