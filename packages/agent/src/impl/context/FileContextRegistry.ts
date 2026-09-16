import { isPlainObject } from '@velaros-ai/core'

import type { ContextPayloadStore } from '../../contract/requires.js'
import type { FileContextCarrier } from '../../types/context.js'
import { childKeepsFileSources } from '../../utils/context/file-context-coordinator'

import type { FileContextCoordinatorApi } from './FileContextCoordinator'
import { FileContextCoordinator } from './FileContextCoordinator'

/**
 * 文件上下文协调器的登记处：按「执行 tracker 对象」把协调器挂在那次执行上，同一个 tracker 反复取到
 * 同一份协调器，tracker 被回收后登记项随之消失（弱引用，不留全局会话）。
 *
 * 宿主进程一份（文件末尾那个 `fileContextRegistry`）；会话与存储都来自每次传进来的载体，
 * 载体换了会话或换了 payload 存储时旧协调器作废，重新建一份。
 */
export interface FileContextRegistryApi {
  /**
   * 取（必要时新建）这个载体对应的文件上下文协调器。
   * 载体没有执行作用域、没有 sessionId 或没有 payload 存储时返回 undefined —— 这种载体上的读取
   * 不归任何执行分支所有，不该拿到协调器。
   */
  for(carrier: FileContextCarrier): FileContextCoordinatorApi | undefined
  /**
   * 派生子分支的文件上下文：子分支拿到自己的作用域，只继承父分支的来源访问口，
   * 不继承父分支的活跃源码与预算。子分支已经看不见读文件的工具时连来源也不继承。
   */
  fork(parent: FileContextCarrier, child: FileContextCarrier): void
}

class FileContextRegistry implements FileContextRegistryApi {
  /** 执行 tracker → 那次执行的协调器；连同建它时的会话与存储一起记，二者任一变化就重建。 */
  private readonly coordinators = new WeakMap<
    object,
    { sessionId: string; store: ContextPayloadStore; coordinator: FileContextCoordinatorApi }
  >()

  public for(carrier: FileContextCarrier): FileContextCoordinatorApi | undefined {
    const owner = carrier.fileContextScope ?? carrier.codingSession
    if (!owner || !isPlainObject(owner)  || !carrier.sessionId || !carrier.contextPayloadStore)
      return undefined
    const existing = this.coordinators.get(owner)
    if (
      existing &&
      existing.sessionId === carrier.sessionId &&
      existing.store === carrier.contextPayloadStore
    )
      return existing.coordinator
    const coordinator = new FileContextCoordinator(carrier.contextPayloadStore, carrier.sessionId)
    this.coordinators.set(owner, {
      sessionId: carrier.sessionId,
      store: carrier.contextPayloadStore,
      coordinator,
    })
    return coordinator
  }

  public fork(parent: FileContextCarrier, child: FileContextCarrier): void {
    const previous = this.for(parent)
    child.fileContextScope = {}
    if (!previous) return
    this.for(child)?.inheritSources(previous, (source) => childKeepsFileSources(child, source))
  }
}

/** 宿主进程唯一的一份文件上下文登记处。 */
export const fileContextRegistry: FileContextRegistryApi = new FileContextRegistry()
