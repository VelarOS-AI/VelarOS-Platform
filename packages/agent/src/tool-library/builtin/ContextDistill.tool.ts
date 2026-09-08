import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { toNullable } from '@velaros-ai/core'

import { defineVelaTool } from '../defineVelaTool'

import { AgentContextSignalCapability } from './Capabilities'

// 兼容事实便签受整体载荷预算约束，不使用过小的条目数硬限制。20 条精炼事实占用与旧版
// 10 × 400 的契约大致相当，同时允许长阶段为每个已完成工作项保留独立可寻址的事实。
const DistilledFactMaxChars = 240
const DistilledFactMaxCount = 20
const DistillNoteMaxChars = 300

export interface DistillContextInput extends Record<string, unknown> {
  facts: string[]
  note?: string
}

const distillContextSchema = z.object({
  facts: z
    .array(z.string().trim().min(1).max(DistilledFactMaxChars))
    .min(1)
    .max(DistilledFactMaxCount)
    .describe(
      parameterDescription({
        description: '从已读取/搜索/执行结果中蒸馏出的持久事实。',
        notes: [
          `最多 ${DistilledFactMaxCount} 条，每条不超过 ${DistilledFactMaxChars} 字符；事实较多时先合并重复项。`,
          '每条自包含，代码事实带 file:line 或符号名；决策写清结论和原因。',
          '只记新知识，之前 distill 过的事实不要重复。',
        ],
      })
    ),
  note: z
    .string()
    .trim()
    .min(1)
    .max(DistillNoteMaxChars)
    .optional()
    .describe(
      parameterDescription({
        description: '一句话进度便签：当前做到哪里、下一步是什么。',
        notes: ['被打断或上下文压缩后靠它恢复现场，避免重读文件。'],
      })
    ),
})

/**
 * 兼容已发布的事实便签工具。默认工具面由目标、证据与召回工具维护；旧宿主显式注册此导出时，
 * 仅在工具结果中保留事实与进度，不再请求压缩。容量治理统一由运行时自动决定。
 */
const distillContext = defineVelaTool<DistillContextInput>({
  name: 'context:distill',
  role: 'control',
  category: 'context',
  summary: '记录已确认的关键事实与进度便签。',
  outputInline: true,
  suitable: [
    '旧宿主使用此事实便签接口，需要记录已确认结论和当前进度时。',
  ],
  forbidden: ['不要将尚未验证的推测记录为事实。'],
  usage: ['facts 传增量事实（代码事实带 file:line），note 传一句话进度便签。'],
  examples: [
    {
      facts: ['治理 epoch 状态机在 GovernanceEpoch.ts，按 I0 逐出 → I1 骨架顺序执行'],
      note: '机制已完成，下一步补常驻注册',
    },
  ],
  notes: ['蒸馏便签本身不会被折叠，是压缩后仍在的断点锚；不要重复记录同一事实。'],
  schema: distillContextSchema,
  permissions: [],
  capabilities: AgentContextSignalCapability,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()

    // 保留旧结果的事实字段供历史记录与召回读取；兼容调用不能绕过自动容量治理。
    return {
      distilled: true,
      epochRequested: false,
      compactionStatus: 'automatic',
      facts: input.facts,
      note: toNullable(input.note),
      effect:
        '事实与进度便签已记录在本次工具结果中。系统按实际容量自动整理上下文；原文可按需使用 context:recall 取回。',
    }
  },
})

/** @deprecated 供旧宿主保留事实便签兼容；压缩由运行时自动管理。 */
const contextDistillTools = {
  'context:distill': distillContext,
}

export { contextDistillTools, distillContextSchema }
