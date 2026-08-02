import { defineToolRuntimeSpec, type ToolContractRuntimeSpec } from '@velaros-ai/core/tool-contract'
import type { ToolPermission } from '@velaros-ai/core/types'
import type { ProjectToolContext } from '@velaros-ai/project/agent'

import { DevelopmentQuerySchema, type DevelopmentQuery } from './query-schema'

const DevelopmentToolNames = Object.freeze({ queryCode: 'development:query-code' } as const)

interface DevelopmentToolApi {
  isCodeQueryAvailable: () => boolean
  queryCode: (input: DevelopmentQuery, context: ProjectToolContext) => Promise<unknown>
}

interface DevelopmentToolContext extends ProjectToolContext {
  development: DevelopmentToolApi
}

type DevelopmentTool = ToolContractRuntimeSpec<
  DevelopmentQuery,
  DevelopmentToolContext,
  unknown,
  ToolPermission
>

const developmentQueryCode: DevelopmentTool = defineToolRuntimeSpec({
  name: DevelopmentToolNames.queryCode,
  category: 'development-code',
  role: 'inspect',
  summary: '统一执行代码符号、关系、依赖、诊断和影响面查询。',
  suitable: [
    '需要语义级符号关系、调用链、依赖、诊断或影响面。',
    '需要构建或检查代码索引。',
  ],
  forbidden: ['普通字面量或正则搜索应使用 project:search。'],
  protocol: ['先选择 action，再提供该 action 所需的字段。'],
  usage: [
    '索引查询使用 search_symbols、build_context、callers、callees、impact 等 action。',
    '即时语言服务查询使用 find_symbols、find_references、language_diagnostics 等 action。',
  ],
  examples: [
    { action: 'search_symbols', query: 'UserService', limit: 20 },
    { action: 'find_references', symbol: 'UserService', path: 'src/user.ts' },
  ],
  notes: ['关系类 action 的 nodeId 必须来自前序查询结果，不要猜测。'],
  schema: DevelopmentQuerySchema,
  permissions: ['fs:read'],
  hideWhenUnavailable: true,
  isAvailable: (context) => context.development.isCodeQueryAvailable(),
  isConcurrencySafe: () => true,
  execute: (input, context) => context.development.queryCode(input, context),
})

const developmentTools = Object.freeze({
  [DevelopmentToolNames.queryCode]: developmentQueryCode,
})

export { DevelopmentToolNames, developmentTools }
export type { DevelopmentTool, DevelopmentToolApi, DevelopmentToolContext }
