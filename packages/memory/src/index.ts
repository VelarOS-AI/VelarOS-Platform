import { structureToolDescriptionsForCategory } from '@velaros-ai/core/utils/ToolDescription'

import { memoryTools as rawMemoryTools } from './tools/memory'

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
  MemorySystemApi,
  MemoryToolContext,
  MemoryTreeRuntimeProviders,
  ToolContext,
  VelaTool,
} from './Types'

export const memoryTools = structureToolDescriptionsForCategory(rawMemoryTools, 'memory')
