// AiSdkAgentModelRequestPort 用到的纯函数（不碰实例状态）。
import { isFiniteNumber } from '@velaros-ai/core'

import type { AgentModelRequestOptions } from '../../contract/requires.js'
import type { ModelRequestPolicyTarget } from '../../types/loop.js'

/** 本次请求没给这个数字时才用策略里的缺省值。 */
export function applyPolicyNumber(
  current: Optional<number>,
  policyValue: Optional<number>
): number | undefined {
  if (isFiniteNumber(current)) return current
  return isFiniteNumber(policyValue) ? policyValue : current
}

/** 把宿主给的请求策略并进这次模型请求：只补请求自己没给的字段。 */
export function applyModelRequestPolicy<TRequest extends object>(
  request: TRequest,
  modelRequestOptions?: LooseOptional<AgentModelRequestOptions>
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
