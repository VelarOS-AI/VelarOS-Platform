import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ApprovalPort } from '../../contract/requires.js'
import type { ToolConfirmationDecisionOptions } from '../../types/agent'
import type { ManualApprovalOptions, UnattendedApprovalEscalationHooks } from '../../types/toolkit.js'

/**
 * 构造一次必须由用户亲自裁决、且永不复用历史答案的审批请求。
 *
 * `approvalRisk: high` 只描述风险，不等于“任何权限模式都必须弹卡”；`never-ask` 会按其产品
 * 语义自动放行普通高风险请求。凡是工具文案或策略明确承诺“等待用户确认”的地方必须走这个
 * 构造器，避免只漏一个布尔值就把人工门禁降成可自动批准的风险提示。
 */
export function createManualApprovalOptions(
  options: ManualApprovalOptions = {}
): ToolConfirmationDecisionOptions {
  return {
    ...options,
    requireManualApproval: true,
    rememberRiskScope: false,
  }
}

/**
 * 子 Agent 的确认使用父任务同一策略；默认每项请求均委托父端口。
 * 生命周期钩子仅在委托仍等待时投影子任务状态。宿主显式提供 shouldEscalate 时保留其策略。
 */
export function createUnattendedSubAgentApprovalPort(
  delegate: ApprovalPort,
  hooks?: UnattendedApprovalEscalationHooks,
  shouldEscalate: (options?: ToolConfirmationDecisionOptions) => boolean = () => true
): ApprovalPort {
  const withEscalation = async <T>(message: string, run: () => Promise<T>): Promise<T> => {
    let announced = false
    const timers = new TimerScope({ name: 'SubAgentApproval.escalation' })
    timers.after(0, () => {
      announced = true
      hooks?.onEscalationPending?.(message)
    })
    try {
      return await run()
    } finally {
      timers.dispose()
      if (announced) hooks?.onEscalationResolved?.()
    }
  }
  return {
    awaitConfirmation: async (message, abortSignal, options) => {
      if (!shouldEscalate(options)) return
      await withEscalation(message, () =>
        delegate.awaitConfirmation(message, abortSignal, options)
      )
    },
    awaitConfirmationDecision: async (message, abortSignal, options) => {
      if (!shouldEscalate(options))
        return { approved: true, message: null, autoApproved: true }
      return withEscalation(message, () =>
        delegate.awaitConfirmationDecision(message, abortSignal, options)
      )
    },
  }
}

/** 无审批通道宿主返回给模型的设计式拒绝文案。 */
const DEFAULT_DENY_MESSAGE = '该操作需要用户审批，但当前宿主没有审批通道，已按默认拒绝处理。'

/**
 * 无审批通道宿主的默认端口：一切需要审批的操作按**设计式拒绝**处理。
 *
 * 用于 web 桥等没有确认 UI 的执行层宿主，以及任何 execution 为 null 的构造路径。
 * 终止型确认抛 `PERMISSION` 错误、非终止型返回结构化拒绝信封（而非旧的 `ctx.execution!`
 * null 崩溃事故式拒绝），让模型能向用户解释并改用更安全的方式。
 */
export const defaultDenyApprovalPort: ApprovalPort = {
  awaitConfirmation: async () => {
    throw new AppError('PERMISSION', DEFAULT_DENY_MESSAGE)
  },
  awaitConfirmationDecision: async () => ({
    approved: false,
    message: DEFAULT_DENY_MESSAGE,
    autoApproved: false,
  }),
}
