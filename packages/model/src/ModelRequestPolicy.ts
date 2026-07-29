import { isFiniteNumber } from '@velaros-ai/core'
import type { ModelRequestOptions } from './ModelContracts'

type ModelRequestPolicyTarget = {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
}

function isFinitePolicyNumber(value: unknown): value is number {
  return isFiniteNumber(value)
}

function applyPolicyNumber(
  current: number | undefined,
  policyValue: number | undefined
): number | undefined {
  if (isFinitePolicyNumber(current)) return current
  return isFinitePolicyNumber(policyValue) ? policyValue : current
}

function applyModelRequestPolicy<TRequest extends object>(
  request: TRequest,
  modelRequestOptions?: LooseOptional<ModelRequestOptions>
): TRequest {
  const policy = modelRequestOptions?.requestPolicy
  if (!policy) return request

  const target = request as TRequest & ModelRequestPolicyTarget
  return {
    ...target,
    temperature: applyPolicyNumber(target.temperature, policy.temperature),
    topP: applyPolicyNumber(target.topP, policy.topP),
    maxOutputTokens: applyPolicyNumber(target.maxOutputTokens, policy.maxOutputTokens),
  } as TRequest
}

export { applyModelRequestPolicy }
