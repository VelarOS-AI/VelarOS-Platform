import { structureToolDescriptionsForCategory } from '@velaros-ai/agent/tool-contract'

import { memoryTools as rawMemoryTools } from './tools/memory'

export * from './backend'
export * from './memory-tree'
export { MemoryTreeDomain as MemoryDomain } from './memory-tree'
export * from './MemoryScope'
export {
  createMemoryRuntime,
  DefaultMemoryRuntime,
  MemoryRuntime,
} from './Runtime'
export type {
  MemoryApi,
  MemoryDatabaseProvider,
  MemorySessionLineageContext,
  MemoryToolContext,
  MemoryTreeRuntimeProviders,
  ToolContext,
  VelaTool,
} from './Types'

export const memoryTools = structureToolDescriptionsForCategory(rawMemoryTools, 'memory')
