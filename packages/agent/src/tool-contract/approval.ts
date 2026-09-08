import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ApprovalDecision, ToolConfirmationDecisionOptions } from '../protocol/types/agent'

export type ManualApprovalOptions = Omit<
  ToolConfirmationDecisionOptions,
  'requireManualApproval' | 'rememberRiskScope'
>

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
 * 审批通道端口。
 *
 * 把「要不要问、问谁、答案是什么」抽象成一个通道：工具只管请求审批，
 * 具体如何征询（确认卡 / 策略自动放行 / 无通道时设计式拒绝）由宿主注入的实现决定。
 * 决策形状与风险分类复用现有确认机制（{@link ToolConfirmationDecisionOptions} /
 * {@link ApprovalDecision}），不引入平行的第二套风险模型。
 *
 * 两种征询形态对齐现有 execution 确认机制：{@link ApprovalPort.awaitConfirmation}
 * 被拒会抛出仅取消当前操作的错误，{@link ApprovalPort.awaitConfirmationDecision} 是非终止型
 * （被拒返回结构化决策）。二者都只表达「审批」，不承载计划/任务/用户输入等交互会话能力。
 */
export interface ApprovalPort {
  /**
   * 请求一次工具执行审批；被拒或无审批通道时**抛出**，由工具执行器记录跳过，任务继续。
   *
   * @param message 面向用户的确认文案。
   * @param abortSignal 取消信号；征询被中止时应视为拒绝。
   * @param options 风险分类与复用/手动确认策略（approvalRisk / riskScope / requireManualApproval 等）。
   */
  awaitConfirmation(
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<void>
  /**
   * 请求一次工具执行审批，返回**结构化决策**（非终止型）。
   *
   * @returns approved 是否放行、message 拒绝原因或批注、autoApproved 是否策略自动放行。
   */
  awaitConfirmationDecision(
    message: string,
    abortSignal?: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<ApprovalDecision>
}

/**
 * 无人值守审批升级的生命周期钩子：升级挂起 / 升级返回。
 *
 * 供宿主把「子 Agent 正等父线程裁决高风险操作」投影成 UI 状态（如 worker 线程状态卡）；
 * 端口本体不承载任何宿主文案，钩子只回传原始 message，格式化归宿主。
 */
export interface UnattendedApprovalEscalationHooks {
  onEscalationPending?: (message: string) => void
  onEscalationResolved?: () => void
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
