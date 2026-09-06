import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'

import { defineVelaTool } from '../defineVelaTool'

import { AgentUserInteractionCapability } from './Capabilities'

const HandoffReasonMaxChars = 400

export interface HandoffContextInput extends Record<string, unknown> {
  reason: string
}

export const handoffContextSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(HandoffReasonMaxChars)
    .describe(
      parameterDescription({
        description: '为什么当前会话已经不适合继续，以及交接后应继续处理什么。',
        notes: ['用户会看到交接批准卡；写清必要性，不要把普通进度更新当成交接理由。'],
      })
    ),
})

const handoffContext = defineVelaTool<HandoffContextInput>({
  name: 'context:handoff',
  role: 'control',
  category: 'context',
  summary: '请求用户批准把当前任务交接到新会话；只有显式调用才会显示批准/拒绝卡。',
  outputInline: true,
  suitable: [
    '当前会话在多次安全压缩后仍无法继续，继续运行会撞上下文上限时。',
    '任务确实需要换到干净会话才能可靠继续，并且可以给出清晰续跑理由时。',
  ],
  forbidden: [
    '不要仅因上下文占用升高就调用；先使用现有驻留回收、context:distill 和 context:recall。',
    '用户拒绝后不要在同一任务里反复调用。',
    '不要把它当成自动交接：调用只展示卡片，批准或拒绝由用户决定。',
  ],
  usage: ['传入简洁 reason；调用后等待用户在交接卡上批准或拒绝。'],
  examples: [
    {
      reason: '本会话已完成多轮压缩但仍接近上限；新会话应从当前验证失败继续修复。',
    },
  ],
  notes: ['系统不会因压力信号自动调用或自动批准该工具。'],
  schema: handoffContextSchema,
  permissions: [],
  capabilities: AgentUserInteractionCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const requestHandoff = ctx.conversation.requestHandoff
    if (!requestHandoff) return {
      requested: false,
      sessionId: ctx.sessionId,
      reason: input.reason,
      unavailableReason: '当前宿主不支持会话交接卡。',
    }

    return requestHandoff({ reason: input.reason })
  },
})

const contextHandoffTools = {
  'context:handoff': handoffContext,
}

export { contextHandoffTools }
