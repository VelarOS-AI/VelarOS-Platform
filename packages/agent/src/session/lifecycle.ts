import type {
  AgentBackgroundAgentState,
  AgentSessionLease,
  AgentSessionLeaseClaim,
} from './contracts'

export class AgentSessionLeaseConflictError extends Error {
  public constructor(
    public readonly sessionId: string,
    public readonly ownerPid: number,
    productName = 'Agent host'
  ) {
    super(`Session ${sessionId} is active in another ${productName} process (PID ${ownerPid}).`)
    this.name = 'AgentSessionLeaseConflictError'
  }
}

/**
 * 在产品存储事务内裁决单执行 owner。返回值由产品原子写入自己的 SQLite/文件/Cloud adapter；
 * Platform 不探测 OS 进程，也不拥有持久化。
 */
export function resolveAgentSessionLeaseClaim(
  current: AgentSessionLease | null,
  claim: AgentSessionLeaseClaim,
  isProcessAlive: (pid: number) => boolean,
  now: number,
  productName?: string
): AgentSessionLease {
  const ownerId = claim.ownerId.trim()
  if (!claim.sessionId.trim()) throw new Error('Session lease Session ID cannot be empty.')
  if (!ownerId) throw new Error('Session lease owner ID cannot be empty.')
  if (!Number.isInteger(claim.ownerPid) || claim.ownerPid <= 0) {
    throw new Error('Session lease owner PID must be a positive integer.')
  }
  if (current && current.ownerId !== ownerId && isProcessAlive(current.ownerPid)) {
    throw new AgentSessionLeaseConflictError(claim.sessionId, current.ownerPid, productName)
  }
  return {
    sessionId: claim.sessionId,
    ownerId,
    ownerPid: claim.ownerPid,
    acquiredAt: now,
    heartbeatAt: now,
  }
}

export function isTerminalAgentBackgroundState(state: AgentBackgroundAgentState): boolean {
  return state === 'completed'
    || state === 'failed'
    || state === 'stopped'
    || state === 'interrupted'
}

export function normalizeAgentSessionListLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 100, 1_000))
}
