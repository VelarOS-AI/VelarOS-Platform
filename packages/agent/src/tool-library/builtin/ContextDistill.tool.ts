import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { toNullable } from '@velaros-ai/core'

import { defineVelaTool } from '../defineVelaTool'

import { AgentContextSignalCapability } from './Capabilities'

// 手动蒸馏受整体载荷预算约束，不使用过小的条目数硬限制。20 条精炼事实占用与旧版
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
 * 蒸馏与召回共同组成上下文治理原语。模型调用它表示当前阶段已经完成，治理器会在下一轮边界
 * 执行逐出与骨架化；信号直接从账本读取，不另设侧信道，因而能够离线重放。
 * 蒸馏便签会作为摘要记录保留，供中断后恢复现场。
 */
const distillContext = defineVelaTool<DistillContextInput>({
  name: 'context:distill',
  role: 'control',
  category: 'context',
  summary: '声明当前阶段已完成：记录蒸馏后的关键事实与进度便签，并请求对已消化的旧上下文做一次压缩。',
  outputInline: true,
  suitable: [
    '一批读取/搜索/命令输出完成使命、结论可用几条事实概括时；典型时机是探索完动手前、大改完验证前。',
    'context-dashboard 显示占用偏高、而当前阶段刚好告一段落时——阶段边界压缩比撑到溢出再压好得多。',
  ],
  forbidden: ['不要蒸馏马上要逐字引用的结果；压缩后需 context:recall 才能取回原文。'],
  usage: ['facts 传增量事实（代码事实带 file:line），note 传一句话进度便签；下一个轮边界会据此跑一次上下文压缩。'],
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

    // 机制由历史消息承载：这条结果本身就是**信号**——治理器在下一个轮边界按 toolName 认它，
    // 把它当作一次 epoch 请求。handler 零副作用是刻意的（见文件头"为什么 handler 仍然零副作用"）。
    return {
      distilled: true,
      epochRequested: true,
      compactionStatus: 'queued_for_next_turn_boundary',
      facts: input.facts,
      note: toNullable(input.note),
      effect:
        '压缩请求已排队，尚未在本次工具回包中完成；下一个轮边界会尝试把陈旧/重复的旧结果降级为可召回墓碑，并把叙事段合成规则骨架。之后以 context-dashboard 的 epoch/summarized/evicted 变化判断是否实际生效。原文可用 context:recall(ref=toolCallId, refKind:"tool-payload") 取回。',
    }
  },
})

const contextDistillTools = {
  'context:distill': distillContext,
}

export { contextDistillTools, distillContextSchema }
