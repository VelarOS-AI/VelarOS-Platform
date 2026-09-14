import { z } from 'zod'

export const ProjectSearchInputSchema = z.object({
  query: z.string().min(1),
  path: z.string().optional(),
  include: z.array(z.string().min(1)).max(20).optional(),
  exclude: z.array(z.string().min(1)).max(20).optional(),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
  contextLines: z.number().int().nonnegative().max(10).optional(),
}).strict()
export type ProjectSearchInput = z.infer<typeof ProjectSearchInputSchema>
