import { z } from 'zod'

import type { ProjectCodeQuery } from '../../src/types/project'

const languageQueryFields = {
  language: z.string().optional(),
  cwd: z.string().optional(),
  limit: z.number().transform((value) => Math.min(200, Math.max(1, Math.round(value)))).optional(),
  extensions: z.array(z.string().min(1)).max(20).optional(),
  maxDepth: z.number().transform((value) => Math.min(16, Math.max(0, Math.round(value)))).optional(),
}

/**
 * 宿主代码查询（`ProjectToolApi.queryCode` 收到的 `ProjectCodeQuery`）的可执行规格：测试用它核对本包翻译出来的查询都合规，
 * 旧版 query-code 驱动器也拿它当入参 schema。包里不导出它，形状的权威是 types/project.ts 里的类型。
 */
export const ProjectCodeQuerySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('search_symbols'),
    query: z.string().min(1),
    kind: z.string().optional(),
    limit: z.number().transform((value) => Math.min(50, Math.max(1, Math.round(value)))).optional().default(20),
  }),
  z.object({
    action: z.literal('build_context'),
    task: z.string().min(1),
    maxNodes: z.number().transform((value) => Math.min(40, Math.max(1, Math.round(value)))).optional().default(20),
  }),
  z.object({ action: z.literal('explore'), nodeIds: z.array(z.string().min(1)).min(1).max(12) }),
  z.object({ action: z.literal('trace'), fromSymbol: z.string().min(1), toSymbol: z.string().min(1) }),
  z.object({ action: z.literal('read_node'), nodeId: z.string().min(1) }),
  z.object({
    action: z.literal('callers'),
    nodeId: z.string().min(1),
    depth: z.number().transform((value) => Math.min(5, Math.max(1, Math.round(value)))).optional().default(2),
  }),
  z.object({
    action: z.literal('callees'),
    nodeId: z.string().min(1),
    depth: z.number().transform((value) => Math.min(5, Math.max(1, Math.round(value)))).optional().default(2),
  }),
  z.object({
    action: z.literal('impact'),
    nodeId: z.string().min(1),
    depth: z.number().transform((value) => Math.min(5, Math.max(1, Math.round(value)))).optional().default(2),
  }),
  z.object({ action: z.literal('type_hierarchy'), nodeId: z.string().min(1) }),
  z.object({ action: z.literal('file_dependencies'), path: z.string().min(1) }),
  z.object({
    action: z.literal('find_cycles'),
    maxFiles: z.number().transform((value) => Math.min(120, Math.max(10, Math.round(value)))).optional(),
  }),
  z.object({
    action: z.literal('find_dead_code'),
    limit: z.number().transform((value) => Math.min(80, Math.max(1, Math.round(value)))).optional().default(30),
  }),
  z.object({ action: z.literal('routing_manifest'), framework: z.string().optional() }),
  z.object({ action: z.literal('build_index'), force: z.boolean().optional().default(true) }),
  z.object({ action: z.literal('index_status') }),
  z.object({
    action: z.literal('find_symbols'),
    ...languageQueryFields,
    query: z.string().optional(),
    path: z.string().optional(),
    exportedOnly: z.boolean().optional(),
    kinds: z.array(z.string().min(1)).max(12).optional(),
    exact: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('list_exports'),
    ...languageQueryFields,
    path: z.string().optional(),
    query: z.string().optional(),
    includeReExports: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('find_imports'),
    ...languageQueryFields,
    path: z.string().optional(),
    specifier: z.string().optional(),
    kind: z.string().optional(),
    includeExternal: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('find_importers'),
    ...languageQueryFields,
    targetPath: z.string().optional(),
    specifier: z.string().optional(),
    path: z.string().optional(),
    includeReExports: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('find_references'),
    ...languageQueryFields,
    symbol: z.string().min(1),
    path: z.string().optional(),
    exactWord: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('language_diagnostics'),
    ...languageQueryFields,
    path: z.string().min(1),
  }),
  z.object({
    action: z.literal('analyze_symbol_impact'),
    ...languageQueryFields,
    symbol: z.string().min(1),
    path: z.string().optional(),
    declarationPath: z.string().optional(),
    kinds: z.array(z.string().min(1)).max(12).optional(),
  }),
]) satisfies z.ZodType<ProjectCodeQuery>
