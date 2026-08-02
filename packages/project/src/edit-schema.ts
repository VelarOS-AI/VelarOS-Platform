import { z } from 'zod'

const ProjectPathSchema = z.string().min(1)

const ProjectEditOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('replace_text'),
    path: ProjectPathSchema,
    oldText: z.string().min(1),
    newText: z.string(),
  }),
  z.strictObject({
    type: z.literal('insert_text_at_anchor'),
    path: ProjectPathSchema,
    anchorText: z.string().min(1),
    position: z.enum(['before', 'after']),
    text: z.string().min(1),
    expectedMatches: z.number().int().positive().optional(),
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
    patches: z.array(z.strictObject({
      op: z.enum(['add', 'remove', 'replace']),
      path: z.string(),
      value: z.unknown().optional(),
    })).min(1),
  }),
])

const ProjectEditIntentSchema = z.strictObject({
  operation: ProjectEditOperationSchema,
  reason: z.string().optional(),
  constraints: z.strictObject({
    maxChangedLines: z.number().int().positive().optional(),
    expectedMatches: z.number().int().positive().optional(),
  }).optional(),
})

const ProjectEditOperationsSchema = z.array(ProjectEditIntentSchema)

export {
  ProjectEditIntentSchema,
  ProjectEditOperationSchema,
  ProjectEditOperationsSchema,
}
