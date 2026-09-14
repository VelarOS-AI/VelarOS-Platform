import { executeProjectCode } from '../../code/query.js'
import { ProjectCodeSchema } from '../../project-code-contracts.js'
import { ProjectToolNames } from '../../project-tool-names.js'
import { ProjectReadCapability } from '../ProjectCapabilities.js'

import { defineProjectTool } from './shared.js'

export const projectCode = defineProjectTool({
  name: ProjectToolNames.code,
  category: 'development-code',
  role: 'inspect',
  summary: '查询符号、引用候选、依赖、调用/类型关系、影响范围与诊断；返回查询来源和覆盖范围。',
  suitable: ['需要理解代码结构、定位声明、评估修改影响或检查诊断。'],
  usage: [
    'symbols 可按 query/path 搜索；exportedOnly=true 包含可选 re-export；target 返回声明/body 范围和当前源码。',
    'target 使用前序 symbolRef 或 {path,symbol,container?}，无需填写后端节点 ID。path 搜索范围与 target 声明位置分开。',
    'dependencies：outgoing 查询 path 内的依赖，可选 kind/includeExternal；incoming 查询谁依赖 path 或 specifier，可选 within/includeReExports。按 direction 所属分支填写字段。',
    'degraded 表示能力或覆盖有限；引用候选、空诊断和未启用的关系后端不能当作精确验证。',
  ],
  notes: ['本轮提供 project:code-analysis 时，可用它查询高级 trace/cycles/deadcode/routing；索引生命周期由宿主管理。'],
  examples: [
    { action: 'symbols', query: 'UserService' },
    { action: 'references', target: { path: 'src/user.ts', symbol: 'UserService' } },
    { action: 'dependencies', direction: 'outgoing', path: 'src', includeExternal: true },
    { action: 'dependencies', direction: 'incoming', path: 'src/user.ts', within: 'src', includeReExports: true },
  ],
  schema: ProjectCodeSchema,
  permissions: ['fs:read'],
  capabilities: ProjectReadCapability,
  exposure: { tier: 'situational', rank: 30 },
  isConcurrencySafe: () => true,
  execute: executeProjectCode,
})
