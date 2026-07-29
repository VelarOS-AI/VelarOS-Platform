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
 * 蒸馏折叠：与 recall_context 配对的上下文管理原语。
 *
 * 调用本身就是「消化边界」——历史清洗时，本 conversation 内位于最后一次 distill 之前的
 * 非失败工具结果会立即折叠成 recall 句柄（见 microCompaction 的消化边界逻辑），
 * 蒸馏便签则永久保留在历史中充当断点锚。工具执行零副作用，机制完全由历史消息承载。
 */
const distillContext = defineVelaTool<DistillContextInput>({
  name: 'distill_context',
  role: 'control',
  category: 'general',
  summary: '记录蒸馏后的关键事实与进度便签，并把已消化的旧工具结果折叠成可召回句柄。',
  outputInline: true,
  suitable: [
    '一批读取/搜索/命令输出完成使命、结论可用几条事实概括时；典型时机是探索完动手前、大改完验证前。',
  ],
  forbidden: ['不要蒸馏马上要逐字引用的结果；折叠后需 recall_context 才能取回原文。'],
  usage: ['facts 传增量事实（代码事实带 file:line），note 传一句话进度便签；之前的旧工具结果随后折叠成 recall 句柄。'],
  examples: [
    {
      facts: ['折叠逻辑在 microCompaction.ts:169，按 conversation 保最近 6 条'],
      note: '机制已完成，下一步补常驻注册',
    },
  ],
  notes: ['蒸馏便签本身不会被折叠，是压缩后仍在的断点锚；不要重复记录同一事实。'],
  schema: distillContextSchema,
  permissions: [],
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()

    // 机制由历史消息承载：结果本身就是台账条目，micro-compaction 按 toolName 识别边界。
    return {
      distilled: true,
      facts: input.facts,
      note: toNullable(input.note),
      effect:
        '本 conversation 中位于此调用之前的非失败工具结果将折叠为 recall 句柄；原文可用 recall_context(ref=toolCallId, refKind:"tool-payload") 取回。',
    }
  },
})

const contextDistillTools = {
  distill_context: distillContext,
}

export { contextDistillTools, distillContextSchema }
