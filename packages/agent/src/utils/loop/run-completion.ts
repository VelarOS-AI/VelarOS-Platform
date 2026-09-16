import type { StreamVerificationSummary } from '../../types/agent.js'
import type { CodingSessionSnapshot } from '../../types/session.js'
import { hasVerificationRelevantModifiedPaths } from '../session/verification-relevance'

/** 展示已有验证事实；没有实际验证结果时不从正常返回推导通过。 */
export function buildRunVerificationSummary(snapshot: CodingSessionSnapshot): StreamVerificationSummary | undefined {
  const failure = snapshot.activeVerificationFailure
  if (failure) return { status: failure.status, command: failure.command, issues: [...failure.issues] }
  const status = snapshot.latestVerificationStatus
  if (status) return { status: status === 'passed' && snapshot.needsVerificationCommand ? 'stale' : status }
  return snapshot.hasCapabilityMutations && hasVerificationRelevantModifiedPaths(snapshot)
    ? { status: 'not-run' }
    : undefined
}
