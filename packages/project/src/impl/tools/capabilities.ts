import type { ToolCapabilitySchema } from '@velaros-ai/agent/protocol'

/** 当前活动项目内的只读文件与代码查询。 */
export const ProjectReadCapability = {
  effectKind: 'read',
  readScopes: ['project'],
  filesystem: { read: 'project', write: 'none' },
  canReadArbitrarySource: false,
  concurrency: 'safe',
  metadata: {
    canMutateProject: false,
  },
  reason: 'active project read',
} satisfies ToolCapabilitySchema

/** 当前活动项目内由 Project 事务边界治理的文件修改。 */
export const ProjectWriteCapability = {
  effectKind: 'write',
  readScopes: ['project'],
  writeScopes: ['project'],
  filesystem: { read: 'project', write: 'project' },
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  metadata: {
    canMutateProject: true,
  },
  reason: 'governed active project mutation',
} satisfies ToolCapabilitySchema

/** 项目 cwd 内的命令执行；具体读写与时长由命令参数决定。 */
export const ProjectExecutionCapability = {
  effectKind: 'execute',
  readScopes: ['project'],
  writeScopes: ['project'],
  filesystem: { read: 'project', write: 'project' },
  process: { execution: 'input-dependent' },
  canReadArbitrarySource: false,
  concurrency: 'input-dependent',
  metadata: {
    canMutateProject: true,
  },
  reason: 'active project command execution',
} satisfies ToolCapabilitySchema
