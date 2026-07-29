import { z } from 'zod'

import type { ApprovalPort, ToolContractRuntimeSpec } from '@velaros-ai/core/tool-contract'
import type { ToolPermission } from '@velaros-ai/core/types'
import {
  renderParameterDescription as parameterDescription,
  renderToolDescription,
} from '@velaros-ai/core/utils/ToolDescription'

/**
 * request_confirmation 的最小执行上下文：只需审批通道与取消信号。
 *
 * 声明成 host ToolContext 的**超集**（字段更少），故本工具可赋给宿主更宽的 VelaTool 契约
 * （TContext 逆变），无需把宿主 ToolContext 拖进内核。
 */
interface RequestConfirmationToolContext {
  approval: ApprovalPort
  abortSignal: AbortSignal
}

const requestConfirmationTool: ToolContractRuntimeSpec<
  { message: string },
  RequestConfirmationToolContext,
  { approved: boolean },
  ToolPermission
> = {
  description: renderToolDescription({
    description: '向用户请求一次明确确认。',
    suitable: ['执行高风险、长期运行或需要人工授权的动作前。'],
    forbidden: ['不要用于普通说明或不需要用户决策的信息提示。'],
    usage: ['传 message 描述待确认动作；工具会暂停当前 execution。'],
    examples: ['请求确认即将运行可能写文件的命令。'],
    notes: [
      '用户批准后继续，拒绝时终止本次 execution。',
      '表单/多卡改用 show_user_action_cards。',
    ],
  }),
  schema: z.object({
    message: z.string().min(1).describe(
      parameterDescription({
        description: '需要用户确认的内容。',
        usage: ['说明即将执行的动作、原因和影响范围。'],
      })
    ),
  }),
  permissions: [],
  isConcurrencySafe: () => false,
  execute: async ({ message }, ctx) => {
    await ctx.approval.awaitConfirmation(message, ctx.abortSignal, {
      requireManualApproval: true,
    })
    return { approved: true }
  },
}

const confirmationTools = {
  request_confirmation: requestConfirmationTool,
}

export { confirmationTools }
