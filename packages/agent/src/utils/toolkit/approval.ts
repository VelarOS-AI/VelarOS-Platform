import type { ToolConfirmationDecisionOptions } from '../../types/agent.js'
import type { ManualApprovalOptions } from '../../types/toolkit.js'

/**
 * 构造一次必须由用户亲自裁决、且永不复用历史答案的审批请求。
 *
 * `approvalRisk: high` 只描述风险，不等于"任何权限模式都必须弹卡"；`never-ask` 会按其产品
 * 语义自动放行普通高风险请求。凡是工具文案或策略明确承诺"等待用户确认"的地方必须走这个
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
