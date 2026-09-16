
/** Agent 自有 session 上下文读取，不触碰宿主文件或外部资源。 */
import type { ToolCapabilitySchema } from '../../types/agent.js'

export const AgentContextReadCapability: ToolCapabilitySchema = {
  effectKind: 'read',
  readScopes: ['agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent session context read',
}

/** Active directive 等 session 上下文状态更新。 */
export const AgentContextWriteCapability: ToolCapabilitySchema = {
  effectKind: 'write',
  readScopes: ['agent-session-context'],
  writeScopes: ['agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent session context update',
}

/** 兼容事实便签写入；记录保存在会话工具结果中，可并发合并。 */
export const AgentContextSignalCapability: ToolCapabilitySchema = {
  effectKind: 'write',
  readScopes: ['agent-session-context'],
  writeScopes: ['agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent session facts record',
}

/** 当前 session 的 goal / plan 状态读取。 */
export const AgentPlanningReadCapability: ToolCapabilitySchema = {
  effectKind: 'read',
  readScopes: ['agent-session-planning'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent session planning read',
}

/** 当前 session 的 goal / plan 状态更新；并发写可能丢失进度。 */
export const AgentPlanningWriteCapability: ToolCapabilitySchema = {
  effectKind: 'write',
  readScopes: ['agent-session-planning'],
  writeScopes: ['agent-session-planning'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent session planning update',
}

/** 单次子 Agent 派发；调度器负责有界并发。 */
export const AgentDispatchCapability: ToolCapabilitySchema = {
  effectKind: 'execute',
  readScopes: ['agent-session-context', 'agent-tool-space'],
  writeScopes: ['agent-subagents', 'agent-background-jobs'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'sub-agent dispatch execution',
}

/** 多节点 Workflow 会统一编排、归约并更新一组子 Agent 执行。 */
export const AgentWorkflowCapability: ToolCapabilitySchema = {
  effectKind: 'execute',
  readScopes: ['agent-session-context', 'agent-tool-space'],
  writeScopes: ['agent-subagents', 'agent-background-jobs'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'multi-agent workflow execution',
}

/** 当前 session 后台 job 状态与输出读取。 */
export const AgentBackgroundJobReadCapability: ToolCapabilitySchema = {
  effectKind: 'read',
  readScopes: ['agent-background-jobs'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent background job read',
}

/** 中断当前 session 的后台 Agent 执行。 */
export const AgentBackgroundJobCancelCapability: ToolCapabilitySchema = {
  effectKind: 'execute',
  readScopes: ['agent-background-jobs'],
  writeScopes: ['agent-background-jobs', 'agent-subagents'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent background job cancellation',
}

/** 向用户展示确认或会话交接决策，并等待宿主交互结果。 */
export const AgentUserInteractionCapability: ToolCapabilitySchema = {
  effectKind: 'external',
  writeScopes: ['user-interaction', 'agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent user interaction request',
}
