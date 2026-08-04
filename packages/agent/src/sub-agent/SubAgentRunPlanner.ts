import type { SubAgentTaskRequest, SubAgentTypeId } from '@velaros-ai/agent/protocol'

interface SubAgentRunPreCheckResult {
  allow: boolean
  reason?: string
  suggestedAction?: 'dispatch' | 'main-agent-direct'
  suggestedType?: SubAgentTypeId
}

function preCheckSubAgentDispatch(
  request: Pick<SubAgentTaskRequest, 'prompt' | 'subagent_type' | 'thread_id'>
): SubAgentRunPreCheckResult {
  if (request.thread_id) return { allow: true, suggestedAction: 'dispatch' }
  return {
    allow: true,
    suggestedAction: 'dispatch',
    suggestedType: request.subagent_type,
  }
}

export { preCheckSubAgentDispatch }
export type { SubAgentRunPreCheckResult }
