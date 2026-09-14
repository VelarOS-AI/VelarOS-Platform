import { z } from 'zod'

import { isNotUndefined, isUndefined } from '@velaros-ai/core'

import { normalizeProjectLineRange } from '../../editing/selectors/range.js'
import type { ProjectLineRange } from '../../editing/types.js'

import { ProjectLineRangeSchema } from './range.js'

export { ProjectLineRangeSchema }
export type { ProjectLineRange }
export function readLineRange(range?: ProjectLineRange) {
  if (isUndefined(range)) return undefined
  const [startLine, endLine] = normalizeProjectLineRange(range)
  return { startLine, endLine }
}

export const ProjectReadInputSchema = z.object({
  path: z.string().min(1).optional(),
  range: ProjectLineRangeSchema.optional(),
  files: z.array(z.object({ path: z.string().min(1), range: ProjectLineRangeSchema.optional() }).strict()).min(1).max(20).optional(),
  continuation: z.string().startsWith('read-page:').optional(),
  maxChars: z.number().int().positive().max(500_000).optional(),
}).strict().superRefine((input, context) => {
  if ([input.path, input.files, input.continuation].filter(isNotUndefined).length !== 1)
    context.addIssue({ code: 'custom', message: 'Choose one of path, files, or continuation.' })
  if (isNotUndefined(input.range) && isUndefined(input.path))
    context.addIssue({ code: 'custom', path: ['range'], message: 'range belongs to path; batch ranges belong to each files entry.' })
  if (isNotUndefined(input.maxChars) && input.files && input.maxChars < input.files.length)
    context.addIssue({ code: 'custom', path: ['maxChars'], message: 'maxChars must allocate at least one character per file.' })
})

export type ProjectReadInput = z.infer<typeof ProjectReadInputSchema>
