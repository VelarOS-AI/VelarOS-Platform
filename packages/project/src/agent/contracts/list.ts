import { z } from 'zod'

import { isNotUndefined } from '@velaros-ai/core'

export const ProjectListSchema = z.strictObject({
  path: z.string().optional(),
  include: z.array(z.string().min(1)).max(20).optional(),
  exclude: z.array(z.string().min(1)).max(20).optional(),
  recursive: z.boolean().optional().default(false),
  maxDepth: z.number().int().nonnegative().max(30).optional(),
  limit: z.number().int().positive().max(2_000).optional().default(200),
  cursor: z.string().min(1).optional().describe('直接使用上一页返回的 cursor；其余查询条件由游标保存。'),
}).superRefine((input, context) => {
  if (input.cursor && (isNotUndefined(input.path) || input.include || input.exclude || isNotUndefined(input.maxDepth) || input.recursive))
    context.addIssue({ code: 'custom', path: ['cursor'], message: '续页只传 cursor 和可选 limit；修改过滤条件请重新查询。' })
})

export type ProjectListInput = z.infer<typeof ProjectListSchema>
