import { z } from 'zod'

import { isUndefined } from '@velaros-ai/core'

import { ProjectLineRangeSchema } from './range.js'
import { ProjectFileRefSchema } from './reference.js'

const Selector = {
  range: ProjectLineRangeSchema.optional(),
  match: z.string().min(1).optional().describe('区域中唯一的字面源码；省略 range 时只搜索 fileRef 实际可见区域。'),
}

export const ProjectContentEditSchema = z.union([
  z.strictObject({ op: z.literal('replace'), ...Selector, text: z.string() })
    .refine((value) => !isUndefined(value.range) || !isUndefined(value.match), 'replace 需要 range 或 match。'),
  z.strictObject({ op: z.literal('insert'), ...Selector, side: z.enum(['before', 'after']), text: z.string() })
    .refine((value) => !isUndefined(value.range) || !isUndefined(value.match), '定位插入需要 range 或 match。'),
  z.strictObject({ op: z.literal('insert'), at: z.enum(['start', 'end']), text: z.string() }),
]).describe('range 选择完整行；match 从区域选择唯一原文；text 仅填源码。整行操作维护换行边界，字符操作按 text 插入。')

export const ProjectEditFileSchema = z.strictObject({
  fileRef: ProjectFileRefSchema,
  edits: z.array(ProjectContentEditSchema).min(1).max(1000),
})

export const ProjectEditSchema = z.strictObject({
  files: z.array(ProjectEditFileSchema).min(1).max(1000),
})
