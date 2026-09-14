import { executeProjectCodeAnalysis } from '../../code/query.js'
import { ProjectCodeAnalysisSchema } from '../../project-code-contracts.js'
import { ProjectReadCapability } from '../ProjectCapabilities.js'
import type { ProjectToolContext } from '../Types.js'

import { defineProjectTool } from './shared.js'

export function createProjectCodeAnalysisTools(isAvailable: (context: ProjectToolContext) => boolean) {
  const analysis = defineProjectTool({
    name: 'project:code-analysis',
    category: 'development-code',
    role: 'inspect',
    summary: '按需查询代码路径追踪、依赖环、未使用代码候选和框架路由。',
    usage: ['trace 的 from/to 使用符号引用或 {path,symbol}。deadcode 返回候选，删除之前必须核验动态入口。'],
    notes: ['由宿主提供图后端时加载；查询能力与覆盖以实际回执为准。'],
    examples: [{ action: 'cycles' }, { action: 'deadcode', limit: 20 }],
    schema: ProjectCodeAnalysisSchema,
    permissions: ['fs:read'],
    capabilities: ProjectReadCapability,
    exposure: { tier: 'situational', rank: 40 },
    hideWhenUnavailable: true,
    isAvailable,
    isConcurrencySafe: () => true,
    execute: executeProjectCodeAnalysis,
  })
  return Object.freeze({ 'project:code-analysis': analysis })
}

/** Registration is opt-in; a host must provide the availability predicate. */
export const projectCodeAnalysisTools = createProjectCodeAnalysisTools(() => true)
