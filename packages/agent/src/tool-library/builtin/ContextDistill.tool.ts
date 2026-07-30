import { z } from 'zod'

import { toNullable } from '@velaros-ai/core'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { defineVelaTool } from '../defineVelaTool'

const DistilledFactMaxChars = 400
const DistilledFactMaxCount = 10
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
 * 蒸馏折叠：与 `recall_context` 配对的上下文管理原语。
 *
 * ## B1 语义升格：调用 = **请求开一次治理 epoch**
 * 旧语义是"消化边界"——历史清洗时把边界之前的非失败工具结果折成句柄（v1 microCompaction，
 * 已随上下文治理 v2 下线）。新语义是模型**声明阶段完成**：治理器在下一个轮边界把它当作
 * epoch 触发源之一（与预算水位并列），一次性跑 I0 逐出 + I1 规则骨架。依据是阶段边界触发
 * 优于溢出触发的生产实证。
 *
 * ## 为什么 handler 仍然零副作用
 * 信号从**账本结构**里读（`ContextGovernanceSession.consumeModelEpochRequest` 扫最新一条本工具
 * 的 tool-result），不从 handler 往外推：
 *  - 这个事实本来就在历史里逐字可查，推一条侧信道等于同一事实两处真相；
 *  - handler 侧信号需要一条穿过 ToolContext 的新端口（agent 包 host 无关，端口是有成本的）；
 *  - 从账本读天然可离线重放——真实账本喂进治理器就能复现当时的 epoch 决策（B4 的前提）。
 *
 * 蒸馏便签本身以 `summary` 类记录留在上下文里充当断点锚，永不被折叠。
 */
const distillContext = defineVelaTool<DistillContextInput>({
  name: 'distill_context',
  role: 'control',
  category: 'general',
  summary: '声明当前阶段已完成：记录蒸馏后的关键事实与进度便签，并请求对已消化的旧上下文做一次压缩。',
  outputInline: true,
  suitable: [
    '一批读取/搜索/命令输出完成使命、结论可用几条事实概括时；典型时机是探索完动手前、大改完验证前。',
    'context-dashboard 显示占用偏高、而当前阶段刚好告一段落时——阶段边界压缩比撑到溢出再压好得多。',
  ],
  forbidden: ['不要蒸馏马上要逐字引用的结果；压缩后需 recall_context 才能取回原文。'],
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
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()

    // 机制由历史消息承载：这条结果本身就是**信号**——治理器在下一个轮边界按 toolName 认它，
    // 把它当作一次 epoch 请求。handler 零副作用是刻意的（见文件头"为什么 handler 仍然零副作用"）。
    return {
      distilled: true,
      epochRequested: true,
      facts: input.facts,
      note: toNullable(input.note),
      effect:
        '已请求在下一个轮边界开一次上下文压缩：陈旧/重复的旧结果降级为可召回墓碑，被折叠的叙事段合成规则骨架。原文可用 recall_context(ref=toolCallId, refKind:"tool-payload") 取回。',
    }
  },
})

const contextDistillTools = {
  distill_context: distillContext,
}

export { contextDistillTools, distillContextSchema }
