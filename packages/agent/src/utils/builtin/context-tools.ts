// 域：上下文三件套（`context:recall` / `context:handoff` / `context:distill`）的入参形状与结果投影。
//
// 只放 schema 与纯函数：真去召回、真去请交接在 impl/builtin/ContextOperations.ts。
import { z } from 'zod'

import { isPlainObject, isString } from '@velaros-ai/core'

import { AgentToolLimits } from '../../contract/constants.js'
import type { DistillContextInput, HandoffContextInput } from '../../types/builtin.js'
import { renderParameterDescription as parameterDescription } from '../toolkit/tool-description'

/** 交接理由的长度上限模型直接看得见，值在 AgentToolLimits.context.handoffReasonChars。 */
export const handoffContextSchema: z.ZodType<HandoffContextInput> = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(AgentToolLimits.context.handoffReasonChars)
    .describe(
      parameterDescription({
        description: '为什么当前会话已经不适合继续，以及交接后应继续处理什么。',
        notes: ['用户会看到交接批准卡；写清必要性，不要把普通进度更新当成交接理由。'],
      })
    ),
})

// 兼容事实便签受整体载荷预算约束，不使用过小的条目数硬限制。20 条精炼事实占用与旧版
// 10 × 400 的契约大致相当，同时允许长阶段为每个已完成工作项保留独立可寻址的事实。
// 三个上限模型直接看得见，写在 AgentToolLimits.context 里。
/** 事实便签的入参形状：一批精炼事实，外加一句可选的进度便签。 */
export const distillContextSchema: z.ZodType<DistillContextInput> = z.object({
  facts: z
    .array(z.string().trim().min(1).max(AgentToolLimits.context.distilledFactChars))
    .min(1)
    .max(AgentToolLimits.context.distilledFactCount)
    .describe(
      parameterDescription({
        description: '从已读取/搜索/执行结果中蒸馏出的持久事实。',
        notes: [
          `最多 ${AgentToolLimits.context.distilledFactCount} 条，每条不超过 ${AgentToolLimits.context.distilledFactChars} 字符；事实较多时先合并重复项。`,
          '每条自包含，代码事实带 file:line 或符号名；决策写清结论和原因。',
          '只记新知识，之前 distill 过的事实不要重复。',
        ],
      })
    ),
  note: z
    .string()
    .trim()
    .min(1)
    .max(AgentToolLimits.context.distillNoteChars)
    .optional()
    .describe(
      parameterDescription({
        description: '一句话进度便签：当前做到哪里、下一步是什么。',
        notes: ['被打断或上下文压缩后靠它恢复现场，避免重读文件。'],
      })
    ),
})

/** 模型读取统一逻辑正文，持久档案及其分页坐标保留原始文本。 */
export function presentHistoricalFile(value: unknown): unknown {
  if (!isPlainObject(value) || !isString(value.content) || value.kind !== 'file-snapshot') return value
  const content = (value.offset ? value.content : value.content.replace(/^\uFEFF/u, '')).replace(/\r\n/gu, '\n')
  return { ...value, content, contentFormat: 'unicode-lf', offsetUnit: 'archived-utf16',
    pagingNote: '续读时原样使用 nextOffset；它指向归档原文，不能根据显示正文长度推算。' }
}
