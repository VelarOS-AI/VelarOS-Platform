import { createKeyedSerialQueue } from '@velaros-ai/core/utils/KeyedSerialQueue'
import { shortReferenceId } from '@velaros-ai/core/utils/shortReferenceId'

import type { ContextStorage } from '../contract/requires.js'
import type { ContextRef } from '../types/context.js'

/** 同存储实例的引用签发口。 */
export interface ContextReferenceAllocatorApi {
  /** 为当前会话保留一个不会在本生命周期内复用的身份。 */
  allocate(storage: ContextStorage, sessionId: string): Promise<string>
}

/** 注入存储的保底签发器：同实例、同会话串行签发，存储记录及本生命周期的退役身份共同防冲突。 */
class ContextReferenceAllocator implements ContextReferenceAllocatorApi {
  private readonly issued = new WeakMap<ContextStorage, Map<string, Set<string>>>()
  private readonly queue = createKeyedSerialQueue()

  public allocate(storage: ContextStorage, sessionId: string): Promise<string> {
    return this.queue.run(sessionId, async () => {
      let sessions = this.issued.get(storage)
      if (!sessions) {
        sessions = new Map()
        this.issued.set(storage, sessions)
      }
      let issued = sessions.get(sessionId)
      if (!issued) {
        issued = new Set()
        sessions.set(sessionId, issued)
      }
      // 兼容既有长引用；只给新身份签发短引用，原记录仍按精确 id 读取。
      const state = await storage.load(sessionId)
      for (const record of state?.records ?? []) issued.add(record.ref.id)
      const id = shortReferenceId((value) => issued.has(value))
      issued.add(id)
      return id
    })
  }
}

/** 保底签发器按存储实例持有身份，存储回收后签发状态随之回收。 */
export const contextReferenceAllocator: ContextReferenceAllocatorApi =
  new ContextReferenceAllocator()

/** 创建当前会话的短引用；持久存储通过原子签发口保留跨连接、重启和回收后的身份占用。 */
export async function createContextReference(
  storage: ContextStorage,
  sessionId: string
): Promise<ContextRef> {
  if (storage.allocateReferenceId)
    return { sessionId, id: await storage.allocateReferenceId(sessionId) }
  return { sessionId, id: await contextReferenceAllocator.allocate(storage, sessionId) }
}
