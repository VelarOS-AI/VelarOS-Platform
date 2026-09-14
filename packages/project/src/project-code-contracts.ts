import { z } from 'zod'

import { isNotUndefined } from '@velaros-ai/core'
const scope = {
  language: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  extensions: z.array(z.string().min(1)).max(20).optional(),
  maxDepth: z.number().int().nonnegative().max(16).optional(),
}

/** References are returned by symbols; callers never need backend node ids. */
export const ProjectCodeTargetSchema = z.union([
  z.strictObject({ symbolRef: z.string().startsWith('symbol:') }),
  z.strictObject({
    path: z.string().min(1),
    symbol: z.string().min(1),
    container: z.string().min(1).optional(),
  }),
])

export const ProjectCodeSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('symbols'),
    ...scope,
    query: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    kinds: z.array(z.string().min(1)).max(12).optional(),
    exact: z.boolean().optional(),
    exportedOnly: z.boolean().optional(),
    includeReExports: z.boolean().optional(),
    target: ProjectCodeTargetSchema.optional().describe('取得一个符号的声明/body 范围和当前源码。'),
  }).superRefine((input, context) => {
    if (input.target && [input.query, input.path, input.kinds, input.exact, input.exportedOnly, input.includeReExports].some(isNotUndefined))
      context.addIssue({ code: 'custom', message: 'target 详情与搜索过滤互斥。', path: ['target'] })
    if (isNotUndefined(input.includeReExports) && !input.exportedOnly)
      context.addIssue({ code: 'custom', message: 'includeReExports 仅用于 exportedOnly=true。', path: ['includeReExports'] })
  }),
  z.strictObject({
    action: z.literal('references'),
    ...scope,
    target: ProjectCodeTargetSchema,
    path: z.string().min(1).optional().describe('限定引用搜索范围；声明位置由 target 指定。'),
  }),
  z.discriminatedUnion('direction', [
    z.strictObject({
      action: z.literal('dependencies'),
      ...scope,
      direction: z.literal('incoming').describe('谁依赖目标：path 或 specifier 至少提供一个。'),
      path: z.string().min(1).optional().describe('被依赖的目标文件。'),
      specifier: z.string().min(1).optional().describe('匹配 import 的模块说明符，如 node:fs。'),
      within: z.string().min(1).optional().describe('限定调用方的搜索范围。'),
      includeReExports: z.boolean().optional().describe('是否包含重导出该目标的文件。'),
    }).refine((input) => isNotUndefined(input.path) || isNotUndefined(input.specifier), {
      message: 'incoming 需要 path 或 specifier。',
      path: ['path'],
    }).meta({
      // Zod refine 只参与运行时校验；显式把相同的定位要求传给模型。
      anyOf: [{ required: ['path'] }, { required: ['specifier'] }],
    }),
    z.strictObject({
      action: z.literal('dependencies'),
      ...scope,
      direction: z.literal('outgoing').describe('范围内代码依赖谁。'),
      path: z.string().min(1).optional().describe('要查询的文件或目录；省略时查询项目。'),
      specifier: z.string().min(1).optional().describe('按 import 的模块说明符过滤，如 node:fs。'),
      kind: z.string().min(1).optional().describe('按依赖种类过滤。'),
      includeExternal: z.boolean().optional().describe('是否包含项目外部依赖。'),
    }),
  ]),
  z.strictObject({
    action: z.literal('relations'),
    cwd: scope.cwd,
    limit: scope.limit,
    target: ProjectCodeTargetSchema,
    kind: z.enum(['calls', 'types', 'related']),
    direction: z.enum(['incoming', 'outgoing', 'both']).optional().default('both'),
    depth: z.number().int().positive().max(5).optional().default(2),
  }),
  z.strictObject({
    action: z.literal('impact'),
    ...scope,
    target: ProjectCodeTargetSchema,
    path: z.string().min(1).optional(),
    kinds: z.array(z.string().min(1)).max(12).optional(),
    depth: z.number().int().positive().max(5).optional().default(2),
  }),
  z.strictObject({ action: z.literal('diagnostics'), ...scope, path: z.string().min(1) }),
])

/** Optional extension contract. Hosts register this separately with capability discovery. */
export const ProjectCodeAnalysisSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('trace'), from: ProjectCodeTargetSchema, to: ProjectCodeTargetSchema }),
  z.strictObject({ action: z.literal('cycles'), maxFiles: z.number().int().min(10).max(120).optional() }),
  z.strictObject({ action: z.literal('deadcode'), limit: z.number().int().positive().max(80).optional() }),
  z.strictObject({ action: z.literal('routing'), framework: z.string().min(1).optional() }),
])

export type ProjectCodeInput = z.output<typeof ProjectCodeSchema>
export type ProjectCodeTarget = z.output<typeof ProjectCodeTargetSchema>
export type ProjectCodeAnalysisInput = z.output<typeof ProjectCodeAnalysisSchema>
