import type { ModelMessage } from 'ai'

import { isEmpty, isTrue } from '@velaros-ai/core'

import type {
  AgentContextPhaseReason,
} from '../../types/agent'
import type { AgentContextPhaseDecision, ResolveAgentContextPhaseInput } from '../../types/loop.js'
import { resolveExecutionModes } from '../runner/execution-mode-registry'

/**
 * 包一条「本轮走完整 operational 上下文」的裁决，并把命中的那条判据原样带出去。
 * reason 会进日志与遥测，是事后解释「为什么这一轮没能省下 bootstrap 开销」的唯一线索。
 */
function operational(reason: AgentContextPhaseReason): AgentContextPhaseDecision {
  return { phase: 'operational', reason }
}

/**
 * 历史里出现过 assistant 回复或 tool 结果即为真：说明模型已经在半途，不是一次全新提问。
 * 这种轮次若按 bootstrap 削工具面，会把它上一轮刚建立起来的工具面抽走，所以必须回到 operational。
 */
function hasConversationContinuation(history: readonly ModelMessage[]): boolean {
  return history.some((message) => message.role === 'assistant' || message.role === 'tool')
}

/**
 * 历史里存在 user 消息才为真。为假说明这一轮不是用户发起的（系统注入、恢复重放等），
 * 既没有「新问题」可省，也无从判断该留哪些工具，于是宁可走完整 operational 而不是轻量 bootstrap。
 */
function hasUserRequest(history: readonly ModelMessage[]): boolean {
  return history.some((message) => message.role === 'user')
}

/**
 * 只有全新交互任务的第一次 provider 请求使用轻量 bootstrap；工具结果、助手回复或任何
 * 显式执行模式都会自动恢复完整 operational 上下文。
 */
function resolveAgentContextPhase(input: ResolveAgentContextPhaseInput): AgentContextPhaseDecision {
  if (input.turn > 1) return operational('continued-provider-loop')
  if (input.agentSurfaceId === 'scheduled-task') return operational('scheduled-task')
  if (isTrue(input.unattended)) return operational('unattended-execution')
  // 拆轴后「任一执行模式在场」都算显式执行姿态：goal 照旧，plan 也不再需要靠
  // `promptFeatures.length` 这条能力判据顺带命中（能力轴上已经没有 plan 了）。
  if (!isEmpty(resolveExecutionModes(input))) return operational('execution-mode')
  if (input.selectedSkillIds?.some((id) => !!id.trim())) return operational('selected-skill')
  if (input.promptFeatures?.length) return operational('selected-capability')
  if (isTrue(input.hasActiveContext)) return operational('active-context')
  if (hasConversationContinuation(input.history))
    return operational('existing-conversation-history')
  if (!hasUserRequest(input.history)) return operational('missing-user-request')

  return {
    phase: 'bootstrap',
    reason: 'initial-interactive-request',
  }
}

export { resolveAgentContextPhase }
