/**
 * 产品面：记忆包交给外面的整件能力。
 *
 * 类实现的 API 定义在各自类的上方（`impl/` 里，接口紧挨着类一起导出），这里用
 * `export type { X } from '../impl/<域>/<类文件>.js'` 登记；没有类的公开接口直接声明在这里。
 * 改这个文件等于改对外契约。
 */

import type { TurnContextSessionLedgersApi } from '@velaros-ai/agent'

import type { MemoryAdapterApi } from '../impl/host/MemoryAdapterRuntime.js'
import type {
  ForgetMemoryInput,
  GetMemoryInput,
  SaveMemoryInput,
  SearchMemoriesInput,
} from '../types/tool.js'

import type { VelaTool } from './requires.js'

export type {
  LayeredMemoryStoreBackend,
  LayeredMemoryStoreBackendOptions,
} from '../impl/backends/LayeredMemoryStore.js'
export type { MemoryBackendsApi } from '../impl/backends/MemoryBackends.js'
export type { MemoryScopesApi } from '../impl/backends/MemoryScopes.js'
export type { InMemoryMemoryFilesIoApi } from '../impl/files/InMemoryMemoryFilesIo.js'
export type { MemoryFilesBackendApi } from '../impl/files/MemoryFilesBackend.js'
export type { MemoryAdapterApi } from '../impl/host/MemoryAdapterRuntime.js'
export type {
  MemoryDreamSchedulerApi,
  MemoryDreamSchedulerOptions,
} from '../impl/host/MemoryDreamScheduler.js'
export type {
  MemoryEvidenceBridgeApi,
  MemoryEvidenceBridgeOptions,
} from '../impl/host/MemoryEvidenceBridge.js'
export type { MemoryStoreCapabilitiesApi } from '../impl/host/MemoryStoreCapabilities.js'
export type {
  MemoryServiceOptions,
  MemoryTreeServiceApi,
} from '../impl/host/MemoryTreeService.js'
export type { MemoryTurnRecallCoordinatorApi } from '../impl/host/MemoryTurnRecallCoordinator.js'
export type { MemoryToolOperationsApi } from '../impl/MemoryToolOperations.js'
export type { MemoryTreeDomainApi } from '../impl/tree/MemoryTreeDomain.js'
export type { MemoryRuntime } from '../impl/tree/MemoryTreeRuntime.js'
export type { FileVectorIndexStoreOptions } from '../impl/vector/FileVectorIndexStore.js'
export type { InMemoryVectorIndexStoreApi } from '../impl/vector/InMemoryVectorIndexStore.js'
export type { MemoryVectorBackendOptions } from '../impl/vector/MemoryVectorBackend.js'

/**
 * 回合上下文增量源的结构化视图：本包自持这一份形状，不借宿主的枚举。
 *
 * 宿主把它注册进自己的回合上下文表，模型下一轮就能看到这一路增量。
 */
export interface MemoryTurnContextDeltaSource {
  /** 源 id，宿主按它认这一路增量。 */
  id: string
  /** 这一路增量允许出现在哪些空间。 */
  scopes: readonly string[]
  /** 渲染进程看不看得到（记忆注入只对模型可见，固定为 false）。 */
  rendererVisible?: boolean
  /** 读一段还没被消费的增量。 */
  peekCached: (input: {
    sessionId: string
    afterSeq: number
    generation: Nullable<string>
  }) => ReturnType<TurnContextSessionLedgersApi['peek']> & { anchors: [] }
}

/** 装配结果的历史名字；等同 {@link MemoryAdapterApi}，入口收口那一轮删。 */
export type MemoryAdapterMount = MemoryAdapterApi

/** 记忆包交给宿主的四个模型面工具，键就是工具名。 */
export interface MemoryToolCollection {
  /** 写入一条带来源的长期记忆。 */
  readonly 'memory:save': VelaTool<SaveMemoryInput>
  /** 召回当前空间可见的长期记忆。 */
  readonly 'memory:search': VelaTool<SearchMemoriesInput>
  /** 按 id 读取一条记忆的全文与来源。 */
  readonly 'memory:get': VelaTool<GetMemoryInput>
  /** 归档一条记忆，让它退出日常召回。 */
  readonly 'memory:archive': VelaTool<ForgetMemoryInput>
}
