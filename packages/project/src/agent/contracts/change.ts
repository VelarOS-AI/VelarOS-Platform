import { z } from 'zod'

import { isUndefined } from '@velaros-ai/core'

import type { ProjectChangeStep } from '../../editing/types.js'

import { ProjectContentEditSchema } from './edit.js'
import { ProjectRecodeActionSchema } from './file.js'
import { ProjectChangeRefSchema, ProjectFileRefSchema } from './reference.js'

const Source = {
  fileRef: ProjectFileRefSchema.optional(),
  sourceRef: ProjectFileRefSchema.optional().describe('原样复制原 fileRef；跟随此前计划步骤的移动和修改。'),
  path: z.string().min(1).optional().describe('仅引用本计划创建的文件。'),
}

function exactlyOneSource(value: { fileRef?: string; sourceRef?: string; path?: string }): boolean {
  return [value.fileRef, value.sourceRef, value.path].filter((item) => !isUndefined(item)).length === 1
}

export const ProjectPlanFileActionSchema = z.union([
  z.strictObject({ op: z.literal('create'), path: z.string().min(1), text: z.string() }),
  z.strictObject({ op: z.literal('overwrite'), ...Source, text: z.string() }).refine(exactlyOneSource, '仅填写 fileRef、sourceRef、path 之一。'),
  z.strictObject({ op: z.literal('move'), ...Source, to: z.string().min(1) }).refine(exactlyOneSource, '仅填写 fileRef、sourceRef、path 之一。'),
  z.strictObject({ op: z.literal('delete'), ...Source }).refine(exactlyOneSource, '仅填写 fileRef、sourceRef、path 之一。'),
  ProjectRecodeActionSchema,
])

// 来源互斥关系由 exactlyOneSource 校验；Zod 无法从该校验自动推导联合类型。
export const ProjectChangeStepSchema: z.ZodType<ProjectChangeStep> = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('file'), actions: z.array(ProjectPlanFileActionSchema).min(1).max(1000) }),
  z.strictObject({
    tool: z.literal('edit'),
    files: z.array(z.strictObject({ ...Source, edits: z.array(ProjectContentEditSchema).min(1).max(1000) })
      .refine(exactlyOneSource, '仅填写 fileRef、sourceRef、path 之一。')).min(1).max(1000),
  }),
]) as z.ZodType<ProjectChangeStep>

export const ProjectChangeSchema = z.strictObject({
  action: z.enum(['apply', 'inspect', 'undo']),
  steps: z.array(ProjectChangeStepSchema).min(1).max(1000).optional(),
  changeRef: ProjectChangeRefSchema.optional(),
}).superRefine((value, context) => {
  if (value.action === 'apply' ? !value.steps || !isUndefined(value.changeRef) : !value.changeRef || !isUndefined(value.steps)) {
    context.addIssue({ code: 'custom', message: 'apply 仅填写 steps；inspect/undo 仅填写 changeRef。' })
  }
})
