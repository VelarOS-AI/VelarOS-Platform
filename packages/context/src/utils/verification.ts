import { isArray, isEmpty } from '@velaros-ai/core'

import { ContextVerificationLimits } from '../contract/constants.js'
import type {
  ContextCompletionResult,
  ContextDeliveryRequirement,
  ContextVerificationCheck,
} from '../types/context.js'

import { contextFailure } from './state.js'
import { checkDeliveryRequirement, checkVerificationReport } from './view-input.js'

/** 必需交付项与逐项事实共同决定是否通过；总体主张不能覆盖遗漏或失败。 */
export function completionVerification(
  value: Omit<ContextCompletionResult, 'completed'>,
  requirements: readonly ContextDeliveryRequirement[]
): Omit<ContextCompletionResult, 'completed'> {
  if (value.report) checkVerificationReport(value.report)
  const checks = [...(value.report?.checks ?? [])]
  const ids = new Set<string>()
  for (const check of checks) {
    if (!check.id) continue
    if (ids.has(check.id)) throw contextFailure('VALIDATION', '领域核查项身份重复')
    ids.add(check.id)
  }
  for (const requirement of requirements) {
    const index = checks.findIndex((check) => check.id === requirement.id)
    const check = index < 0 ? undefined : checks[index]
    const coversArtifacts = requirement.artifacts.every((identity) =>
      check?.artifacts?.some((artifact) => artifact.identity === identity)
    )
    const next: ContextVerificationCheck = {
      ...check,
      id: requirement.id,
      label: requirement.label,
      requirement,
      status: check?.status === 'failed' ? 'failed' : coversArtifacts ? check!.status : 'unknown',
      complete: coversArtifacts ? check!.complete : false,
    }
    if (index < 0) checks.push(next)
    else checks[index] = next
  }
  // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：未声明 complete 的普通检查保持部分范围，必需项必须明确 true。
  const missing = checks.filter(
    (check) =>
      check.status !== 'passed' ||
      check.complete === false ||
      (requirements.some((item) => item.id === check.id) && check.complete !== true)
  )
  if (isEmpty(missing) && isEmpty(requirements)) return value
  const report = {
    scope: value.report?.scope ?? 'required-delivery',
    checkedAt: value.report?.checkedAt ?? new Date().toISOString(),
    checks,
  }
  checkVerificationReport(report)
  if (isEmpty(missing)) return { ...value, report }
  return {
    ...value,
    verified: false,
    recovery: value.recovery ?? 'repair',
    report,
    reason: value.verified
      ? `REQUIRED_VERIFICATION_INCOMPLETE: ${missing.map((check) => check.id ?? check.label).join(', ')}`
      : value.reason,
  }
}

/** 在调用领域核查器前固定交付范围，禁止运行中的对象修改缩小验收。 */
export function verificationRequirements(
  requirements: readonly ContextDeliveryRequirement[]
): readonly ContextDeliveryRequirement[] {
  if (!isArray(requirements) || requirements.length > ContextVerificationLimits.checks)
    throw contextFailure('VALIDATION', '必需交付项清单无效')
  const ids = new Set<string>()
  for (const item of requirements) {
    checkDeliveryRequirement(item)
    if (ids.has(item.id)) throw contextFailure('VALIDATION', '必需交付项身份或说明无效')
    ids.add(item.id)
  }
  return structuredClone(requirements)
}
