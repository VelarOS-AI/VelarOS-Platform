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
  ContextVerificationArtifact,
  ContextVerificationCheck,
  ContextVerificationCost,
  ContextVerificationFingerprint,
} from '../types/context.js'

import { contextFailure } from './state.js'
import { checkVerificationReport } from './view-input.js'

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
