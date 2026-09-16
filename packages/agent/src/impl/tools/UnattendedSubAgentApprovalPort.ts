import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ApprovalPort } from '../../contract/requires.js'
import type { ToolConfirmationDecisionOptions } from '../../types/agent.js'
import type { UnattendedApprovalEscalationHooks } from '../../types/toolkit.js'

/**
 * 子 Agent 的确认端口：使用父任务同一策略，默认每项请求均委托父端口。
 *
 * 生命周期钩子只在委托仍在等待时投影子任务状态；宿主显式提供 shouldEscalate 时保留其策略。
 */
class UnattendedSubAgentApprovalPort implements ApprovalPort {
  constructor(
    private readonly delegate: ApprovalPort,
    private readonly hooks?: UnattendedApprovalEscalationHooks,
    private readonly shouldEscalate: (
      options?: ToolConfirmationDecisionOptions
    ) => boolean = () => true
  ) {}

  /** 终止型确认：按策略决定是否上报父端口。 */
  public async awaitConfirmation(
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<void> {
    if (!this.shouldEscalate(options)) return
    await this.withEscalation(message, () =>
      this.delegate.awaitConfirmation(message, abortSignal, options)
    )
  }

  /** 非终止型确认：不上报时按自动批准返回。 */
  public async awaitConfirmationDecision(
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): ReturnType<ApprovalPort['awaitConfirmationDecision']> {
    if (!this.shouldEscalate(options))
      return { approved: true, message: null, autoApproved: true }
    return this.withEscalation(message, () =>
      this.delegate.awaitConfirmationDecision(message, abortSignal, options)
    )
  }

  /** 委托期间把"正在等父端口"的状态投影给钩子；结束后一定复位。 */
  private async withEscalation<T>(message: string, run: () => Promise<T>): Promise<T> {
    let announced = false
    const timers = new TimerScope({ name: 'SubAgentApproval.escalation' })
    timers.after(0, () => {
      announced = true
      this.hooks?.onEscalationPending?.(message)
    })
    try {
      return await run()
    } finally {
      timers.dispose()
      if (announced) this.hooks?.onEscalationResolved?.()
    }
  }
}

/** 按父端口开一条子 Agent 审批通道。 */
function createUnattendedSubAgentApprovalPort(
  delegate: ApprovalPort,
  hooks?: UnattendedApprovalEscalationHooks,
  shouldEscalate?: (options?: ToolConfirmationDecisionOptions) => boolean
): ApprovalPort {
  return new UnattendedSubAgentApprovalPort(delegate, hooks, shouldEscalate)
}

export { createUnattendedSubAgentApprovalPort }
