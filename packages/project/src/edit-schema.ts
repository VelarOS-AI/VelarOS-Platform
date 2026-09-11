import { z } from 'zod'

import { isEmpty, isPresent, isTrue } from '@velaros-ai/core'

const ProjectPathSchema = z.string().min(1)

// 三个字段正交：expectedMatches 只断言总数，occurrence / replaceAll 才决定改哪里；
// 描述要让模型一眼看出组合规则，避免把 expectedMatches=1 当成「只改第一处」。
const TextMatchSelectionSchema = {
  expectedMatches: z.number().int().positive().optional().describe(
    '总数断言：文件中该文本的匹配总数必须恰好等于此值，否则失败；它不选择修改位置。可与 occurrence 或 replaceAll 同用。'
  ),
  occurrence: z.number().int().positive().optional().describe(
    '按文件中出现顺序只修改第 N 个匹配（从 1 开始）；与 replaceAll 互斥。若同时给 expectedMatches，须等于实际总数而不是 1。'
  ),
  replaceAll: z.boolean().optional().describe(
    '修改全部匹配；与 occurrence 互斥。occurrence 与 replaceAll 都不传时，文件中必须恰好只有 1 处匹配。'
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
  }).superRefine((operation, context) => {
    const hasBindings = isPresent(operation.defaultImport)
      || isPresent(operation.namespaceImport)
      || isPresent(operation.named)
    if (!isPresent(operation.importStatement) && !isPresent(operation.module)) {
      context.addIssue({
        code: 'custom',
        message: 'add_import 需要 importStatement 或 module。',
        path: ['importStatement'],
      })
    }
    if (isPresent(operation.importStatement) && (isPresent(operation.module) || hasBindings || isTrue(operation.sideEffectOnly))) {
      context.addIssue({
        code: 'custom',
        message: 'importStatement 不能与 module、绑定字段或 sideEffectOnly 同时使用。',
        path: ['importStatement'],
      })
    }
    if (isPresent(operation.module) && !isTrue(operation.sideEffectOnly) && !hasBindings) {
      context.addIssue({
        code: 'custom',
        message: 'module 形式需要 sideEffectOnly=true，或至少一个 named、defaultImport、namespaceImport binding。',
        path: ['module'],
      })
    }
    if (isTrue(operation.sideEffectOnly) && hasBindings) {
      context.addIssue({
        code: 'custom',
        message: 'sideEffectOnly 不能与 named、defaultImport 或 namespaceImport 同时使用。',
        path: ['sideEffectOnly'],
      })
    }
    if (isPresent(operation.namespaceImport) && (isPresent(operation.named) || isPresent(operation.defaultImport))) {
      context.addIssue({
        code: 'custom',
        message: 'namespaceImport 不能与 named 或 defaultImport 同时使用。',
        path: ['namespaceImport'],
      })
    }
  }),
  z.strictObject({
    type: z.literal('remove_import'),
    path: ProjectPathSchema,
    importStatement: z.string().min(1).optional(),
    moduleSpecifier: z.string().min(1).optional(),
    module: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  }).superRefine((operation, context) => {
    const selectors = [
      operation.importStatement,
      operation.moduleSpecifier,
      operation.module,
      operation.name,
    ].filter(isPresent)
    if (isEmpty(selectors)) {
      context.addIssue({
        code: 'custom',
        message: 'remove_import 至少需要 importStatement、moduleSpecifier、module 或 name 之一。',
        path: ['importStatement'],
      })
    }
    if (isPresent(operation.name) && !isPresent(operation.moduleSpecifier) && !isPresent(operation.module)) {
      context.addIssue({
        code: 'custom',
        message: '按 name 删除 binding 时必须同时指定 moduleSpecifier 或 module。',
        path: ['name'],
      })
    }
    if (isPresent(operation.moduleSpecifier) && isPresent(operation.module)) {
      context.addIssue({
        code: 'custom',
        message: 'moduleSpecifier 与兼容别名 module 不能同时使用。',
        path: ['moduleSpecifier'],
      })
    }
    if (isPresent(operation.importStatement) && selectors.length > 1) {
      context.addIssue({
        code: 'custom',
        message: 'importStatement 是完整语句选择器，不能与其他 remove_import 选择器同时使用。',
        path: ['importStatement'],
      })
    }
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
