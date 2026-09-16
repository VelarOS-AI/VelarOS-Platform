// KernelContextEpochGuard 用到的纯函数（不碰实例状态）。
import { isPresent } from '@velaros-ai/core'

import type { BuildKernelContextEpochInput, KernelContextEpoch, RecordKernelContextEpochDiagnosticOptions } from '../../types/loop.js'
import type { ProviderTurnRecorder } from '../../types/records.js'
import { normalizeLabel, normalizeNonNegativeInteger, normalizeOptionalLabel, normalizeOptionalNonNegativeInteger, normalizePercent, sortedUnique } from '../../utils/loop/context-epoch'
import { UnknownGovernanceSessionId } from '../../utils/residency/session-key'

/** 把一轮的会话、阶段、轮次与模型折成上下文纪元。 */
export function buildKernelContextEpoch(input: BuildKernelContextEpochInput): KernelContextEpoch {
  const epoch: KernelContextEpoch = {
    sessionId: normalizeLabel(input.sessionId, UnknownGovernanceSessionId),
    scope: normalizeOptionalLabel(input.scope),
    phase: input.phase,
    turn: normalizeOptionalNonNegativeInteger(input.turn),
    model: normalizeLabel(input.model, 'unknown-model'),
    messageCount: normalizeNonNegativeInteger(input.messageCount),
    availableToolNames: sortedUnique([...input.availableToolNames]),
    contextUsage: {
      estimatedTokens: normalizeNonNegativeInteger(input.contextUsage.estimatedTokens),
      tokenPercent: normalizePercent(input.contextUsage.tokenPercent),
      usableContextWindow: normalizeNonNegativeInteger(input.contextUsage.usableContextWindow),
    },
    createdAt: normalizeNonNegativeInteger(input.createdAt ?? Date.now()),
  }
  if (isPresent(input.requestFingerprint)) {
    epoch.requestFingerprint = input.requestFingerprint
  }
  return epoch
}

/** 把一条上下文纪元诊断写进回合事件归约器。 */
export function recordKernelContextEpochDiagnostic(
  reducer: ProviderTurnRecorder,
  epoch: KernelContextEpoch,
  options: RecordKernelContextEpochDiagnosticOptions = {}
): void {
  reducer.apply({
    type: 'diagnostic',
    code: 'context-epoch',
    message: '已记下这次发往供应方的请求所处的上下文纪元',
    details: {
      sessionId: epoch.sessionId,
      scope: epoch.scope,
      phase: epoch.phase,
      turn: epoch.turn,
      model: epoch.model,
      messageCount: epoch.messageCount,
      availableToolNames: epoch.availableToolNames,
      contextUsage: epoch.contextUsage,
      requestFingerprint: epoch.requestFingerprint,
      createdAt: epoch.createdAt,
      claimKey: options.claim?.key,
      revision: options.claim?.revision,
      current: options.current,
    },
  })
}
