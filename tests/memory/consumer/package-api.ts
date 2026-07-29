import {
  createKnowledgeRuntime,
  KnowledgeRuntime,
  type KnowledgeRuntimeProviders,
  VectorFailureMonitor,
  type VectorFailureMonitorOptions,
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
  type MountMemoryAdapterInput,
} from '@velaros-ai/memory-adapter-kernel'

declare const memoryProviders: MemoryTreeRuntimeProviders
declare const knowledgeProviders: KnowledgeRuntimeProviders
declare const adapterInput: MountMemoryAdapterInput
declare const config: MemoryAdapterConfigPort
declare const hostContext: MemoryAdapterHostContextPort
declare const failureOptions: VectorFailureMonitorOptions

const memory = createMemoryRuntime(memoryProviders)
const memoryContract: MemoryRuntime = memory
const knowledge = createKnowledgeRuntime(knowledgeProviders)
const knowledgeContract: KnowledgeRuntime = knowledge
const adapter: MemoryAdapterRuntime = mountMemoryAdapter(adapterInput)
const failures = new VectorFailureMonitor(failureOptions)

void memory.domain
void knowledge.domain
void knowledge.vectorStore
void adapter.service
void config
void hostContext
void failures
void memoryContract
void knowledgeContract
