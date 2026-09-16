import {
  createKnowledgeRuntime,
  type KnowledgeRuntimeApi,
  type KnowledgeRuntimeProviders,
} from '@velaros-ai/knowledge'
import {
  createMemoryRuntime,
  MemoryRuntime,
  type MemoryTreeRuntimeProviders,
} from '@velaros-ai/memory'
import {
  MemoryAdapterRuntime,
  mountMemoryAdapter,
  type MemoryAdapterConfigPort,
  type MemoryAdapterHostContextPort,
  type MemoryAdapterTreePort,
  type MountMemoryAdapterInput,
} from '@velaros-ai/memory/adapter-kernel'
import type { MemoryStoreBackend } from '@velaros-ai/memory/backend'

declare const memoryProviders: MemoryTreeRuntimeProviders
declare const knowledgeProviders: KnowledgeRuntimeProviders
declare const adapterInput: MountMemoryAdapterInput
declare const config: MemoryAdapterConfigPort
declare const hostContext: MemoryAdapterHostContextPort
declare const backend: MemoryStoreBackend
declare const tree: MemoryAdapterTreePort

const memory = createMemoryRuntime(memoryProviders)
const memoryContract: MemoryRuntime = memory
const knowledge = createKnowledgeRuntime(knowledgeProviders)
const knowledgeContract: KnowledgeRuntimeApi = knowledge
const adapter: MemoryAdapterRuntime = mountMemoryAdapter(adapterInput)
const standalone = mountMemoryAdapter({ backend, config, hostContext })
const withGovernance = mountMemoryAdapter({ backend, tree, config, hostContext })

void memory.domain
void knowledge.knowledgeDomainService
void knowledge.knowledgeVectors
void adapter.service
void standalone.service
void withGovernance.service
void config
void hostContext
void memoryContract
void knowledgeContract
