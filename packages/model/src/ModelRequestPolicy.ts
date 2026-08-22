import { isFiniteNumber } from '@velaros-ai/core'

import type { ModelRequestOptions } from './ModelContracts'

type ModelRequestPolicyTarget = {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
}

/** 调用方显式给的值优先；策略只在缺席或非有限数时兜底，不覆盖显式意图。 */
function applyPolicyNumber(
  current: Optional<number>,
  policyValue: Optional<number>
): number | undefined {
  if (isFiniteNumber(current)) return current
  return isFiniteNumber(policyValue) ? policyValue : current
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
