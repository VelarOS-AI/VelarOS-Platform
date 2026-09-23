import { isNull, isUndefined } from '@velaros-ai/core'

import type { BoundCapabilityRequirement, CapabilitySessionRecord } from '../../types/serve'
import { capabilityOperationsCover, capabilityScopesCover } from '../../utils/serve/service'
import type { CapabilityCallRequest, CapabilityRequireItem } from '../../utils/wire/capability'

/**
 * 一条连接上的能力会话账本；实例归那条连接（RPC 连接或进程内传输各持一份）。
 *
 * 会话永远不跨连接：清空账本（断线）就等于作废这个客户端的全部绑定。
 */
export interface CapabilitySessionLedgerApi {
  /** 开一条会话，把这批能力要求绑进去；返回带新会话 id 的记录。 */
  open(requires: readonly CapabilityRequireItem[]): CapabilitySessionRecord
  /** 关掉一条会话；返回它本来在不在账本里。 */
  close(sessionId: string): boolean
  /** 判这次调用在不在它声称的那条会话的授权范围内（能力、操作、作用域三项都要对上）。 */
  covers(request: CapabilityCallRequest): boolean
  /** 清掉全部会话（连接断开时调）。 */
  clear(): void
  /** 当前还开着几条会话。 */
  size(): number
}

/** 按连接记账的能力会话账本。 */
export class CapabilitySessionLedger implements CapabilitySessionLedgerApi {
  private readonly sessions = new Map<string, CapabilitySessionRecord>()

  public open(requires: readonly CapabilityRequireItem[]): CapabilitySessionRecord {
    // 会话 id 只要在本进程内不撞；用平台自带的 UUID，免得根入口的引用链上多一个 node:crypto。
    const sessionId = globalThis.crypto.randomUUID()
    const record: CapabilitySessionRecord = {
      sessionId,
      requires: requires.map((item): BoundCapabilityRequirement => ({
        capabilityId: item.capabilityId,
        operations: isNull(item.operations) ? null : new Set(item.operations),
        scope: item.scope,
      })),
    }
    this.sessions.set(sessionId, record)
    return record
  }

  public close(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  public covers(request: CapabilityCallRequest): boolean {
    const session = this.sessions.get(request.sessionId)
    if (isUndefined(session)) return false
    for (const requirement of session.requires) {
      if (requirement.capabilityId !== request.capabilityId) continue
      if (!capabilityOperationsCover(requirement.operations, request.operation)) continue
      if (!capabilityScopesCover(requirement.scope, request.scope)) continue
      return true
    }
    return false
  }

  public clear(): void {
    this.sessions.clear()
  }

  public size(): number {
    return this.sessions.size
  }
}
