import { hasVerificationRelevantModifiedPaths } from '../coding/paths'
import type { StreamVerificationSummary } from '../protocol'
import type { CodingSessionSnapshot } from '../reminders'

/** 展示已有验证事实；没有实际验证结果时不从正常返回推导通过。 */
export function buildRunVerificationSummary(snapshot: CodingSessionSnapshot): StreamVerificationSummary | undefined {
  const failure = snapshot.activeVerificationFailure
  if (failure) return { status: failure.status, command: failure.command, issues: [...failure.issues] }
  const status = snapshot.latestVerificationStatus
  if (status) return { status: status === 'passed' && snapshot.needsVerificationCommand ? 'stale' : status }
  return snapshot.hasCapabilityMutations && hasVerificationRelevantModifiedPaths(snapshot.modifiedPaths)
    ? { status: 'not-run' }
    : undefined
}
