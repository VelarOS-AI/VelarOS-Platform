import {
  isArray,
  isBoolean,
  isEmpty,
  isFiniteNumber,
  isPlainObject,
  isString,
  isUndefined,
} from '@velaros-ai/core'

import { ContextVerificationLimits } from '../contract/constants.js'
import type { ContextVerificationExecution, ContextVerificationSpec } from '../contract/requires.js'
import type {
  ContextCompletionResult,
  ContextDeliveryRequirement,
  ContextVerificationArtifact,
  ContextVerificationCheck,
  ContextVerificationCost,
  ContextVerificationFingerprint,
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
    const proofCoversArtifacts =
      check?.proofRef &&
      check.applicability === 'current' &&
      requirement.artifacts.every((identity) =>
        check.artifacts?.some((artifact) => artifact.identity === identity)
      )
    const next: ContextVerificationCheck = {
      ...check,
      id: requirement.id,
      label: requirement.label,
      requirement,
      status:
        check?.status === 'failed' ? 'failed' : proofCoversArtifacts ? check!.status : 'unknown',
      complete: proofCoversArtifacts ? check!.complete : false,
    }
    if (index < 0) checks.push(next)
    else checks[index] = next
  }
  // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：兼容旧非必需检查的缺省 complete，但当前必需项必须明确 true。
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

/** 证明只覆盖签发时的核查事实；展示名称和需求关联可以补充，判据、结果和产物不可扩写。 */
export function verificationProofMatches(
  check: ContextVerificationCheck,
  issued: ContextVerificationCheck
): boolean {
  const facts = (value: ContextVerificationCheck) =>
    JSON.stringify({
      id: value.id,
      scope: value.scope,
      verifierId: value.verifierId,
      verifierVersion: value.verifierVersion,
      checkedAt: value.checkedAt,
      status: value.status,
      complete: value.complete,
      artifact: value.artifact && [
        value.artifact.identity,
        value.artifact.revision,
        value.artifact.contentHash,
      ],
      artifacts: value.artifacts
        ?.map(({ identity, contentHash, revision }) => [identity, contentHash, revision])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      evidenceRefs: value.evidenceRefs
        ?.map(({ sessionId, id }) => [sessionId, id])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    })
  return facts(check) === facts(issued)
}

/** 只保留真实检查允许返回的事实，证明身份与适用性由宿主 helper 添加。 */
export function verificationExecutionCheck(
  spec: ContextVerificationSpec,
  result: ContextVerificationExecution,
  checkedAt: string,
  artifacts?: readonly ContextVerificationArtifact[]
): ContextVerificationCheck {
  if (
    !isPlainObject(result) ||
    !['passed', 'failed', 'unknown'].includes(result.status) ||
    !isString(result.label) ||
    !result.label ||
    result.label.length > ContextVerificationLimits.labelChars ||
    !isBoolean(result.complete)
  )
    throw contextFailure('VALIDATION', '领域逐项核查结果无效')
  const check: ContextVerificationCheck = {
    label: result.label,
    status: result.status,
    complete: result.complete,
    evidenceRefs: structuredClone(result.evidenceRefs),
    artifact: structuredClone(result.artifact),
    id: spec.id,
    scope: spec.scope,
    verifierId: spec.verifierId,
    verifierVersion: spec.verifierVersion,
    checkedAt,
    artifacts: structuredClone(artifacts),
  }
  checkVerificationReport({ scope: spec.scope, checkedAt, checks: [check] })
  return check
}

/** 核查判据和业务参数的稳定身份。 */
export function verificationSpecKey(spec: ContextVerificationSpec): string {
  return JSON.stringify([spec.id, spec.scope, spec.verifierId, spec.verifierVersion])
}

/** 核对宿主声明的有界检查身份和范围。 */
export function checkVerificationSpec(spec: ContextVerificationSpec): void {
  for (const value of [spec.id, spec.scope, spec.verifierId, spec.verifierVersion])
    if (!isString(value) || !value || value.length > ContextVerificationLimits.scopeChars)
      throw contextFailure('VALIDATION', '核查身份、范围或判据版本无效')
}

/** 核对真实计费依据，缺少报告时保留未知覆盖。 */
export function checkVerificationCost(cost?: ContextVerificationCost): ContextVerificationCost {
  if (isUndefined(cost)) return { coverage: 'unknown', charges: [] }
  if (
    !isPlainObject(cost) ||
    !['complete', 'partial', 'unknown'].includes(cost.coverage) ||
    !isArray(cost.charges) ||
    cost.charges.length > ContextVerificationLimits.charges
  )
    throw contextFailure('VALIDATION', '核查费用依据无效')
  const ids = new Set<string>()
  for (const charge of cost.charges) {
    if (
      !isPlainObject(charge) ||
      !isString(charge.id) ||
      !charge.id ||
      ids.has(charge.id) ||
      charge.id.length > ContextVerificationLimits.scopeChars ||
      !isString(charge.currency) ||
      !/^[A-Z]{3}$/u.test(charge.currency) ||
      !['model', 'external'].includes(charge.kind) ||
      !['actual', 'reference'].includes(charge.basis) ||
      (!isUndefined(charge.amount) && (!isFiniteNumber(charge.amount) || charge.amount < 0)) ||
      (cost.coverage === 'complete' && isUndefined(charge.amount))
    )
      throw contextFailure('VALIDATION', '核查计费分项无效或重复')
    ids.add(charge.id)
  }
  return structuredClone(cost)
}

/** 按真实收费身份合并费用，冲突的依据不能相加。 */
export function mergeVerificationCosts(
  parts: readonly ContextVerificationCost[]
): ContextVerificationCost {
  const charges = new Map<string, ContextVerificationCost['charges'][number]>()
  for (const part of parts)
    for (const charge of part.charges) {
      const prior = charges.get(charge.id)
      if (prior && JSON.stringify(prior) !== JSON.stringify(charge))
        throw contextFailure('VALIDATION', '同一核查计费身份的依据不一致')
      charges.set(charge.id, charge)
    }
  return {
    coverage: parts.every((part) => part.coverage === 'complete')
      ? 'complete'
      : parts.some((part) => part.coverage !== 'unknown')
        ? 'partial'
        : 'unknown',
    charges: [...charges.values()],
  }
}

/** 核对可信原子快照并规范化精确产物集合。 */
export function verificationFingerprint(value: ContextVerificationFingerprint): Optional<string> {
  if (!isPlainObject(value) || !['versioned', 'unknown'].includes(value.status))
    throw contextFailure('VALIDATION', '核查探测未返回可信版本或 unknown')
  if (value.status === 'unknown') return
  for (const item of [value.providerId, value.token, value.authorization])
    if (!isString(item) || !item || item.length > ContextVerificationLimits.scopeChars)
      throw contextFailure('VALIDATION', '核查探测身份或授权代次无效')
  if (
    !isArray(value.artifacts) ||
    isEmpty(value.artifacts) ||
    value.artifacts.length > ContextVerificationLimits.artifacts
  )
    throw contextFailure('VALIDATION', '核查精确产物集合无效')
  const ids = new Set<string>()
  const artifacts = value.artifacts
    .map((artifact) => {
      if (
        !isPlainObject(artifact) ||
        !isString(artifact.identity) ||
        !artifact.identity ||
        artifact.identity.length > ContextVerificationLimits.scopeChars ||
        ids.has(artifact.identity) ||
        !isString(artifact.contentHash) ||
        !artifact.contentHash ||
        artifact.contentHash.length > ContextVerificationLimits.scopeChars ||
        (!isUndefined(artifact.revision) &&
          (!isString(artifact.revision) ||
            !artifact.revision ||
            artifact.revision.length > ContextVerificationLimits.scopeChars))
      )
        throw contextFailure('VALIDATION', '核查产物身份或精确指纹无效')
      ids.add(artifact.identity)
      return [artifact.identity, artifact.contentHash, artifact.revision ?? '']
    })
    .sort((a, b) => a[0]!.localeCompare(b[0]!))
  return JSON.stringify([value.providerId, value.token, value.authorization, artifacts])
}
