import type {
  AgentBackgroundAgentState,
  AgentSessionLease,
  AgentSessionLeaseClaim,
} from '../../contract/requires'
import { AgentTuning } from '../../utils/tuning'

export class AgentSessionLeaseConflictError extends Error {
  public constructor(
    public readonly sessionId: string,
    public readonly ownerPid: number,
    productName = 'Agent 宿主'
  ) {
    super(
      `会话 ${sessionId} 正被另一个 ${productName} 进程（PID ${ownerPid}）持有：同一会话同一时刻只允许一个进程执行。请切换到那个进程继续，或等它退出、租约过期后再重试。`
    )
    this.name = 'AgentSessionLeaseConflictError'
  }
}

/**
 * 在产品存储事务内裁决单执行 owner。返回值由产品原子写入自己的 SQLite/文件/Cloud adapter；
 * Platform 不探测 OS 进程，也不拥有持久化。
 */
export function resolveAgentSessionLeaseClaim(
  current: Nullable<AgentSessionLease>,
  claim: AgentSessionLeaseClaim,
  isProcessAlive: (pid: number) => boolean,
  now: number,
  productName?: string
): AgentSessionLease {
  const ownerId = claim.ownerId.trim()
  if (!claim.sessionId.trim()) throw new Error('会话租约申领缺少 sessionId：无法判断这份租约属于哪个会话。')
  if (!ownerId) throw new Error('会话租约申领缺少 ownerId：没有 owner 就无法在冲突时分辨谁持有租约。')
  if (!Number.isInteger(claim.ownerPid) || claim.ownerPid <= 0) {
    throw new Error(`会话租约申领的 ownerPid 必须是正整数，当前收到 ${claim.ownerPid}：抢占判定要靠它探测持有者进程是否还活着。`)
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

export function normalizeAgentSessionListLimit(limit?: number): number {
  return Math.max(1, Math.min(limit ?? AgentTuning.records.sessionListDefaultLimit, AgentTuning.records.sessionListMaxLimit))
}
