import { isPresent } from '@velaros-ai/core'

import type { EvaluateKernelFinalReadinessInput,KernelFinalReadinessAudit, KernelFinalReadinessReason, KernelFinalReadinessResult } from '../../types/loop.js'
import type { CodingSessionSnapshot } from '../../types/session.js'
import {
  countVerificationRelevantPaths,
  hasVerificationRelevantModifiedPaths,
} from '../session/verification-relevance'

/**
 * 起一份「默认放行」的审计底稿，并顺手数出快照里有多少条改动落在需要验证的路径上
 * （判据由宿主声明，见 `countVerificationRelevantPaths`）；没有快照按 0 计。
 * 放行与拦下两条路都从这份底稿出发，保证两种结局带出的审计字段形状一致，遥测不必分支解析。
 */
function buildBaseAudit(snapshot?: LooseOptional<CodingSessionSnapshot>): KernelFinalReadinessAudit {
  const verificationRelevantPaths = snapshot ? countVerificationRelevantPaths(snapshot) : 0
  return {
    result: 'allowed',
    recovered: false,
    missingVerification: 0,
    failedVerification: 0,
    verificationRelevantPaths,
  }
}

/** 把审计底稿收成「放行」的收尾裁决：没有理由也没有追加消息，循环可以就此结束本次回复。 */
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

/**
 * 把审计底稿收成「拦下」的收尾裁决：带上机器可读的 reason 与要推回给模型的 followupMessage。
 * 收尾门拿到它之后会把这条消息追加进 history 并让循环再跑一轮，而不是结束回复。
 */
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

/**
 * 拼那条推回给模型的「验证仍在红」消息：点名失败的命令（记不到就写 unknown），最多列前 5 条 issue，
 * 末句要求先修好或问用户再收尾。只列 5 条是有意截断——整份构建日志灌进上下文得不偿失，
 * 模型想看全量自己重跑一次验证即可。
 */
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

/**
 * 收尾门里的内核判据：模型这一轮想结束回复了，内核准不准。
 *
 * 三种情况直接放行——拿不到 coding session 快照、本轮没有能力级改动、改动全落在与验证无关的路径上。
 * 只剩一种情况拦下：模型确实跑过验证且当前是失败态（`activeVerificationFailure`，或
 * `latestVerificationStatus === 'failed'`），此时记一次 `failedVerification` 并以
 * `failed-verification` 与一条追加消息拦下，循环据此再跑一轮让模型去修。
 * 「改了代码但根本没跑验证」按用户决策已不再拦（见函数体内注释），别再把它加回来。
 */
function evaluateKernelFinalReadiness(
  input: EvaluateKernelFinalReadinessInput
): KernelFinalReadinessResult {
  const snapshot = input.snapshot
  const audit = buildBaseAudit(snapshot)
  if (!snapshot) return allowFinalReadiness(audit)

  const relevant = hasVerificationRelevantModifiedPaths(snapshot)
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
