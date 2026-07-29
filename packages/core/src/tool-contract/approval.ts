import { AppError } from '../error'
import type { ApprovalDecision, ToolConfirmationDecisionOptions } from '../types/agent'

/**
 * 审批通道端口。
 *
 * 把「要不要问、问谁、答案是什么」抽象成一个通道：工具只管请求审批，
 * 具体如何征询（确认卡 / 策略自动放行 / 无通道时设计式拒绝）由宿主注入的实现决定。
 * 决策形状与风险分类复用现有确认机制（{@link ToolConfirmationDecisionOptions} /
 * {@link ApprovalDecision}），不引入平行的第二套风险模型。
 *
 * 两种征询形态对齐现有 execution 确认机制：{@link ApprovalPort.awaitConfirmation}
 * 是终止型（被拒即抛错），{@link ApprovalPort.awaitConfirmationDecision} 是非终止型
 * （被拒返回结构化决策）。二者都只表达「审批」，不承载计划/任务/用户输入等交互会话能力。
 */
export interface ApprovalPort {
  /**
   * 请求一次工具执行审批；被拒或无审批通道时**抛出**（终止型确认）。
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
 * 无人值守子 Agent 审批策略端口（宪章 §4 策略层 Ring 1）。
 *
 * 表达「默认全放行 + 超高风险升级父线程」——与 standard-open 低风险自动放行是同一家策略：
 * - **非升级风险**：低风险自动放行。终止型 {@link ApprovalPort.awaitConfirmation} 直接 resolve
 *   （= 批准，**不抛错**，终止型审批语义原样保全，不静默蒸发）；非终止型
 *   {@link ApprovalPort.awaitConfirmationDecision} 返回 `{approved:true, autoApproved:true}`。
 * - **升级风险**（由宿主 policy 判定）：冒泡到有人值守的父线程
 *   （`delegate`，通常是父 execution 审批通道）裁决——终止型父拒绝即抛错、语义原样透传；
 *   非终止型透传父决策。破坏性命令硬门化在此表达，语义一字不减。
 */
export function createUnattendedSubAgentApprovalPort(
  delegate: ApprovalPort,
  hooks?: UnattendedApprovalEscalationHooks,
  shouldEscalate: (options?: ToolConfirmationDecisionOptions) => boolean = (options) =>
    options?.requireManualApproval === true || options?.approvalRisk === 'high'
): ApprovalPort {
  const withEscalation = async <T>(message: string, run: () => Promise<T>): Promise<T> => {
    hooks?.onEscalationPending?.(message)
    try {
      return await run()
    } finally {
      hooks?.onEscalationResolved?.()
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
