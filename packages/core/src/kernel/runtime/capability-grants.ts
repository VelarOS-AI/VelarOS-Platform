import { randomUUID } from 'node:crypto'

import type {
  CapabilityCallRequest,
  CapabilityRequireItem,
  ScopeRef,
} from '../protocol'

export interface BoundCapabilityRequirement {
  readonly capabilityId: string
  /** `null` means every operation on the capability. */
  readonly operations: ReadonlySet<string> | null
  readonly scope: ScopeRef | null
}

export interface CapabilitySessionRecord {
  readonly sessionId: string
  readonly requires: readonly BoundCapabilityRequirement[]
}

/**
 * Per-connection ledger of capability sessions.
 *
 * Sessions never cross connections: clearing the ledger (disconnect) drops
 * every binding for that client.
 */
export class CapabilitySessionLedger {
  private readonly sessions = new Map<string, CapabilitySessionRecord>()

  public open(
    requires: readonly CapabilityRequireItem[],
  ): CapabilitySessionRecord {
    const sessionId = randomUUID()
    const record: CapabilitySessionRecord = {
      sessionId,
      requires: requires.map((item) => ({
        capabilityId: item.capabilityId,
        operations: item.operations === null
          ? null
          : new Set(item.operations),
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
    if (session === undefined) return false
    for (const requirement of session.requires) {
      if (requirement.capabilityId !== request.capabilityId) continue
      if (!operationsCover(requirement.operations, request.operation)) continue
      if (!scopesCover(requirement.scope, request.scope)) continue
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

function operationsCover(
  granted: ReadonlySet<string> | null,
  operation: string,
): boolean {
  if (granted === null) return true
  return granted.has(operation)
}

function scopesCover(
  granted: ScopeRef | null,
  requested: ScopeRef | null,
): boolean {
  if (granted === null) return true
  if (requested === null) return false
  return (
    granted.id === requested.id
    && granted.ownerModuleId === requested.ownerModuleId
    && granted.kind === requested.kind
  )
}
