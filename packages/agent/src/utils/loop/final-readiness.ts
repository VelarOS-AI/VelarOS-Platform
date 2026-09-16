import { isPresent } from '@velaros-ai/core'

import type { EvaluateKernelFinalReadinessInput,KernelFinalReadinessAudit, KernelFinalReadinessReason, KernelFinalReadinessResult } from '../../types/loop.js'
import type { CodingSessionSnapshot } from '../../types/session.js'
import {
  hasVerificationRelevantModifiedPaths,
  isVerificationRelevantPath,
} from '../session/paths'

function buildBaseAudit(snapshot?: LooseOptional<CodingSessionSnapshot>): KernelFinalReadinessAudit {
  const verificationRelevantPaths =
    snapshot?.modifiedPaths.filter(isVerificationRelevantPath).length ?? 0
  return {
    result: 'allowed',
    recovered: false,
    missingVerification: 0,
    failedVerification: 0,
    verificationRelevantPaths,
  }
}

function allowFinalReadiness(audit: KernelFinalReadinessAudit): KernelFinalReadinessResult {
  return {
    allowed: true,
    reason: null,
    followupMessage: null,
    audit: {
      ...audit,
      result: 'allowed',
    },
  }
}

function blockFinalReadiness(
  audit: KernelFinalReadinessAudit,
  reason: KernelFinalReadinessReason,
  followupMessage: string
): KernelFinalReadinessResult {
  return {
    allowed: false,
    reason,
    followupMessage,
    audit: {
      ...audit,
      result: 'blocked',
    },
  }
}

function buildFailedVerificationMessage(snapshot: CodingSessionSnapshot): string {
  const failure = snapshot.activeVerificationFailure
  const issues = failure?.issues.slice(0, 5).map((issue) => `- ${issue}`).join('\n')
  return [
    'Host final-answer readiness check failed: the latest verification is still failing.',
    `Command: ${failure?.command ?? '(unknown verification command)'}`,
    issues ? `Issues:\n${issues}` : null,
    'Fix the failure or ask the user before finalizing.',
  ]
    .filter(isPresent)
    .join('\n')
}

function evaluateKernelFinalReadiness(
  input: EvaluateKernelFinalReadinessInput
): KernelFinalReadinessResult {
  const snapshot = input.snapshot
  const audit = buildBaseAudit(snapshot)
  if (!snapshot) return allowFinalReadiness(audit)

  const relevant = hasVerificationRelevantModifiedPaths(snapshot.modifiedPaths)
  if (!snapshot.hasCapabilityMutations || !relevant) return allowFinalReadiness(audit)

  // 已按用户决策移除「缺验证」的收尾硬拦截——不再因为「改了代码但没跑验证」阻止模型收尾。
  // 只保留「验证**失败**」拦截：模型确实跑了验证且红了，才不许收尾。
  if (snapshot.activeVerificationFailure || snapshot.latestVerificationStatus === 'failed') {
    audit.failedVerification = 1
    return blockFinalReadiness(
      audit,
      'failed-verification',
      buildFailedVerificationMessage(snapshot)
    )
  }

  return allowFinalReadiness(audit)
}

export { evaluateKernelFinalReadiness }
