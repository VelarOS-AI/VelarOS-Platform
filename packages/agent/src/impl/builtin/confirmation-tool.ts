import { z } from 'zod'

import type { ToolCapabilitySchema, ToolPermission } from '../../types/agent.js'
import type { RequestConfirmationToolContext } from '../../types/builtin.js'
import type { ToolContractRuntimeSpec } from '../../types/toolkit.js'
import {
  renderParameterDescription as parameterDescription,
  renderToolDescription,
} from '../../utils/toolkit/tool-description'
import { createManualApprovalOptions } from '../tools/DefaultDenyApprovalPort'

const UserConfirmationCapability = {
  effectKind: 'external',
  writeScopes: ['user-interaction'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'explicit user confirmation request',
} satisfies ToolCapabilitySchema

const requestConfirmationTool: ToolContractRuntimeSpec<
  { message: string },
  RequestConfirmationToolContext,
  { approved: boolean },
  ToolPermission
> = {
  name: 'interaction:confirm',
  category: 'interaction',
  role: 'execute',
  readOnly: false,
  description: renderToolDescription({
    description: '向用户请求一次明确确认。',
    suitable: ['执行高风险、长期运行或需要人工授权的动作前。'],
    forbidden: ['不要用于普通说明或不需要用户决策的信息提示。'],
    usage: ['传 message 描述待确认动作；工具会暂停当前 execution。'],
    examples: ['请求确认即将运行可能写文件的命令。'],
    notes: [
      '用户批准后继续，拒绝时终止本次 execution。',
      '表单/多卡改用 interaction:show_action_cards。',
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
  capabilities: UserConfirmationCapability,
  isConcurrencySafe: () => false,
  execute: async ({ message }, ctx) => {
    await ctx.approval.awaitConfirmation(
      message,
      ctx.abortSignal,
      createManualApprovalOptions()
    )
    return { approved: true }
  },
}

const confirmationTools = {
  'interaction:confirm': requestConfirmationTool,
}

export { confirmationTools }
