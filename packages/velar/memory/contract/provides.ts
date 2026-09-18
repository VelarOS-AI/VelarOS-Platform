/**
 * 产品面：本单元交给外面的整件能力。
 *
 * 类实现的 API 定义在各自类的上方（`impl/` 里，接口紧挨着类一起导出），这里用
 * `export type { X } from '../impl/<域>/<类文件>.js'` 登记；没有类的公开接口直接声明在这里。
 * 改这个文件等于改对外契约。
 */

import type { TurnContextSessionLedgersApi } from '@velaros-ai/agent'

export type {
  LayeredMemoryStoreBackend,
  LayeredMemoryStoreBackendOptions,
} from '../impl/backends/LayeredMemoryStore.js'
export type { MemoryBackendsApi } from '../impl/backends/MemoryBackends.js'
export type { MemoryScopesApi } from '../impl/backends/MemoryScopes.js'
export type { MemoryFilesBackendApi } from '../impl/files/MemoryFilesBackend.js'
export type { MemoryAdapterApi } from '../impl/host/MemoryAdapterRuntime.js'
export type { MemoryEvidenceBridgeApi } from '../impl/host/MemoryEvidenceBridge.js'
export type { MemoryStoreCapabilitiesApi } from '../impl/host/MemoryStoreCapabilities.js'
export type {
  MemoryTreeServiceApi,
  MemoryTreeServiceOptions,
} from '../impl/host/MemoryTreeService.js'
export type { MemoryTurnRecallCoordinatorApi } from '../impl/host/MemoryTurnRecallCoordinator.js'
export type { MemoryOperationsApi } from '../impl/MemoryOperations.js'
export type { MemoryTreeDomainApi } from '../impl/tree/MemoryTreeDomain.js'
export type { MemoryTreeRuntimeApi } from '../impl/tree/MemoryTreeRuntime.js'
export type { FileVectorIndexStoreOptions } from '../impl/vector/FileVectorIndexStore.js'
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
