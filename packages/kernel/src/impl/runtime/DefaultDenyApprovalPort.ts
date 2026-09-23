import { AppError } from '@velaros-ai/core/error'

import type { ApprovalPort } from '../../contract/requires.js'

/**
 * 无审批通道宿主的默认端口：一切需要审批的操作按**设计式拒绝**处理。
 *
 * 用于 web 桥等没有确认 UI 的执行层宿主，以及任何 execution 为 null 的构造路径。
 * 终止型确认抛 `PERMISSION` 错误、非终止型返回结构化拒绝信封（而非旧的 `ctx.execution!`
 * null 崩溃事故式拒绝），让模型能向用户解释并改用更安全的方式。
 */
class DefaultDenyApprovalPort implements ApprovalPort {
  /** 无审批通道宿主返回给模型的设计式拒绝文案。 */
  private static readonly DenyMessage =
    '该操作需要用户审批，但当前宿主没有审批通道，已按默认拒绝处理。'

  /** 终止型确认：直接抛 PERMISSION，让调用点按"被拒绝"收尾。 */
  public async awaitConfirmation(): Promise<void> {
    throw new AppError('PERMISSION', DefaultDenyApprovalPort.DenyMessage)
  }

  /** 非终止型确认：返回结构化拒绝信封，模型据此改用更安全的方式。 */
  public async awaitConfirmationDecision(): Promise<{
    approved: boolean
    message: string
    autoApproved: boolean
  }> {
    return { approved: false, message: DefaultDenyApprovalPort.DenyMessage, autoApproved: false }
  }
}

/** 无审批通道宿主的默认端口实例。 */
export const defaultDenyApprovalPort: ApprovalPort = new DefaultDenyApprovalPort()
