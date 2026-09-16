import {
  createKnowledgeRuntime,
  type KnowledgeRuntimeApi,
  type KnowledgeRuntimeProviders,
} from '@velaros-ai/knowledge'
import {
  createMemoryRuntime,
  mountMemoryAdapter,
  type MemoryAdapterApi,
  type MemoryAdapterConfigPort,
  type MemoryAdapterHostContextPort,
  type MemoryAdapterTreePort,
  type MemoryStoreBackend,
  type MemoryTreeRuntimeApi,
  type MemoryTreeRuntimeProviders,
  type MountMemoryAdapterInput,
} from '@velaros-ai/memory'

declare const memoryProviders: MemoryTreeRuntimeProviders
declare const knowledgeProviders: KnowledgeRuntimeProviders
declare const adapterInput: MountMemoryAdapterInput
declare const config: MemoryAdapterConfigPort
declare const hostContext: MemoryAdapterHostContextPort
declare const backend: MemoryStoreBackend
declare const tree: MemoryAdapterTreePort

const memory = createMemoryRuntime(memoryProviders)
const memoryContract: MemoryTreeRuntimeApi = memory
const knowledge = createKnowledgeRuntime(knowledgeProviders)
const knowledgeContract: KnowledgeRuntimeApi = knowledge
const adapter: MemoryAdapterApi = mountMemoryAdapter(adapterInput)
const standalone = mountMemoryAdapter({ backend, config, hostContext })
const withGovernance = mountMemoryAdapter({ backend, tree, config, hostContext })

void memory.memoryDomainService
void knowledge.knowledgeDomainService
void knowledge.knowledgeVectors
void adapter.service
void standalone.service
void withGovernance.service
void config
void hostContext
void memoryContract
void knowledgeContract
