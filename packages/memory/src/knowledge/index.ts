import { structureToolDescriptionsForCategory } from '@velaros-ai/agent/tool-contract'

import { knowledgeTools as rawKnowledgeTools } from './tools/knowledge'

export {
  KnowledgeIndexConfig,
  KnowledgeIndexStatuses,
  KnowledgeMatchTypes,
} from './Constants'
export * from './embedding'
export * from './knowledge/domain'
export * from './knowledge/ingestion'
export * from './knowledge/storage'
export { AgentKnowledgeHelper, KnowledgeContext } from './KnowledgeContext'
export {
  createKnowledgeRuntime,
  DefaultKnowledgeRuntime,
  KnowledgeRuntime,
} from './Runtime'
export * from './shared'
export type {
  EmbeddingRequest,
  EmbeddingRequestConfig,
  EmbeddingRequestFactory,
  KnowledgeApi,
  KnowledgeCodeIntelligenceApi,
  KnowledgeCodeSymbol,
  KnowledgeCodeSymbolKind,
  KnowledgeDatabaseProvider,
  KnowledgeEmbeddingConfigPort,
  KnowledgeEmbeddingRuntime,
  KnowledgeHttpClient,
  KnowledgeIndexingPolicy,
  KnowledgeProjectApi,
  KnowledgeRuntimeProviders,
  KnowledgeStoragePathProvider,
  KnowledgeTool,
  KnowledgeToolContext,
} from './Types'
export {
  type VectorFailureLogger,
  VectorFailureLogWindowMs,
  VectorFailureMonitor,
  type VectorFailureMonitorOptions,
} from './VectorFailureLog'

export const knowledgeTools: typeof rawKnowledgeTools = structureToolDescriptionsForCategory(
  rawKnowledgeTools,
  'knowledge'
)
