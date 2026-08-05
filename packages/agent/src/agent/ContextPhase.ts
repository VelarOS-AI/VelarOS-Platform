import type { ModelMessage } from 'ai'

import type {
  AgentContextPhase,
  AgentContextPhaseReason,
  AgentSurfaceId,
  ChatPromptFeatureId,
  ExecutionModeId,
} from '@velaros-ai/agent/protocol'
import { isEmpty, isTrue } from '@velaros-ai/core'

import { resolveExecutionModes } from '../execution-modes'

interface AgentContextPhaseDecision {
  phase: AgentContextPhase
  reason: AgentContextPhaseReason
}

interface ResolveAgentContextPhaseInput {
  turn: number
  history: readonly ModelMessage[]
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  unattended?: boolean
  /** 执行模式轴；缺席时由旧形态（promptFeatures 里的模式 id / goalMode）折算。 */
  executionModes?: readonly ExecutionModeId[]
  goalMode?: boolean
  selectedSkillIds?: readonly string[]
  promptFeatures?: readonly ChatPromptFeatureId[]
  hasActiveContext?: boolean
}

function operational(reason: AgentContextPhaseReason): AgentContextPhaseDecision {
  return { phase: 'operational', reason }
}

function hasConversationContinuation(history: readonly ModelMessage[]): boolean {
  return history.some((message) => message.role === 'assistant' || message.role === 'tool')
}

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
export type { AgentContextPhaseDecision, ResolveAgentContextPhaseInput }
