import { z } from 'zod'

import { isPresent } from '@velaros-ai/core'

const ProjectPathSchema = z.string().min(1)

const TextMatchSelectionSchema = {
  expectedMatches: z.number().int().positive().optional().describe(
    '安全断言：文件中必须正好存在该数量的匹配；它不表示要修改多少处。'
  ),
  occurrence: z.number().int().positive().optional().describe(
    '只修改第几个匹配（从 1 开始）；与 replaceAll 互斥。'
  ),
  replaceAll: z.boolean().optional().describe(
    '修改全部匹配；与 occurrence 互斥。'
  ),
}

const JsonPatchSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add'),
    path: z.string(),
    value: z.json(),
  }),
  z.strictObject({
    op: z.literal('replace'),
    path: z.string(),
    value: z.json(),
  }),
  z.strictObject({
    op: z.literal('remove'),
    path: z.string(),
  }),
])

const ProjectEditOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('replace_text'),
    path: ProjectPathSchema,
    oldText: z.string().min(1),
    newText: z.string(),
    ...TextMatchSelectionSchema,
  }),
  z.strictObject({
    type: z.literal('insert_text_at_anchor'),
    path: ProjectPathSchema,
    anchorText: z.string().min(1),
    position: z.enum(['before', 'after']),
    text: z.string().min(1),
    ...TextMatchSelectionSchema,
    skipIfAlreadyPresent: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('append_text'),
    path: ProjectPathSchema,
    text: z.string().min(1),
    skipIfAlreadyPresent: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('prepend_text'),
    path: ProjectPathSchema,
    text: z.string().min(1),
    skipIfAlreadyPresent: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('delete_text'),
    path: ProjectPathSchema,
    oldText: z.string().min(1),
    ...TextMatchSelectionSchema,
  }),
  z.strictObject({
    type: z.literal('create_file'),
    path: ProjectPathSchema,
    content: z.string(),
    overwrite: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('delete_file'),
    path: ProjectPathSchema,
  }),
  z.strictObject({
    type: z.literal('rename_file'),
    from: ProjectPathSchema,
    to: ProjectPathSchema,
  }),
  z.strictObject({
    type: z.literal('replace_symbol'),
    path: ProjectPathSchema,
    symbol: z.strictObject({
      kind: z.string().min(1).optional(),
      name: z.string().min(1),
      container: z.string().min(1).optional(),
    }),
    replacement: z.string(),
    mode: z.enum(['whole', 'body']).optional(),
  }),
  z.strictObject({
    type: z.literal('insert_around_symbol'),
    path: ProjectPathSchema,
    symbol: z.strictObject({
      kind: z.string().min(1).optional(),
      name: z.string().min(1),
      container: z.string().min(1).optional(),
    }),
    position: z.enum(['before', 'after']),
    text: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('add_import'),
    path: ProjectPathSchema,
    importStatement: z.string().min(1).optional(),
    module: z.string().min(1).optional(),
    named: z.array(z.string().min(1)).min(1).optional(),
    defaultImport: z.string().min(1).optional(),
    namespaceImport: z.string().min(1).optional(),
    sideEffectOnly: z.boolean().optional(),
    dedupe: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('remove_import'),
    path: ProjectPathSchema,
    importStatement: z.string().min(1).optional(),
    moduleSpecifier: z.string().min(1).optional(),
    module: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('json_patch'),
    path: ProjectPathSchema,
    patches: z.array(JsonPatchSchema).min(1),
  }),
]).superRefine((operation, context) => {
  if (
    'occurrence' in operation
    && isPresent(operation.occurrence)
    && 'replaceAll' in operation
    && operation.replaceAll
  ) {
    context.addIssue({
      code: 'custom',
      message: 'occurrence 与 replaceAll 不能同时使用。',
      path: ['replaceAll'],
    })
  }
})

const ProjectEditIntentSchema = z.strictObject({
  operation: ProjectEditOperationSchema,
  reason: z.string().optional(),
  constraints: z.strictObject({
    maxChangedLines: z.number().int().positive().optional(),
    expectedMatches: z.number().int().positive().optional().describe(
      '兼容字段：断言匹配总数，不选择要修改的匹配；新调用优先放在具体文本 operation 内。'
    ),
  }).optional(),
})

const ProjectEditOperationsSchema = z.array(ProjectEditIntentSchema)

export {
  ProjectEditIntentSchema,
  ProjectEditOperationSchema,
  ProjectEditOperationsSchema,
}
