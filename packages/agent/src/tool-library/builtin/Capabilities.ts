import type { ToolCapabilitySchema } from '@velaros-ai/agent/protocol'

/** Agent 自有 session 上下文读取，不触碰宿主文件或外部资源。 */
export const AgentContextReadCapability = {
  effectKind: 'read',
  readScopes: ['agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent session context read',
} satisfies ToolCapabilitySchema

/** Active directive 等 session 上下文状态更新。 */
export const AgentContextWriteCapability = {
  effectKind: 'write',
  readScopes: ['agent-session-context'],
  writeScopes: ['agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent session context update',
} satisfies ToolCapabilitySchema

/** context:distill 记录可并发合并的治理信号，实际压缩发生在下一轮边界。 */
export const AgentContextSignalCapability = {
  effectKind: 'write',
  readScopes: ['agent-session-context'],
  writeScopes: ['agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent context governance signal',
} satisfies ToolCapabilitySchema

/** 当前 session 的 goal / plan 状态读取。 */
export const AgentPlanningReadCapability = {
  effectKind: 'read',
  readScopes: ['agent-session-planning'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent session planning read',
} satisfies ToolCapabilitySchema

/** 当前 session 的 goal / plan 状态更新；并发写可能丢失进度。 */
export const AgentPlanningWriteCapability = {
  effectKind: 'write',
  readScopes: ['agent-session-planning'],
  writeScopes: ['agent-session-planning'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent session planning update',
} satisfies ToolCapabilitySchema

/** 单次子 Agent 派发；调度器负责有界并发。 */
export const AgentDispatchCapability = {
  effectKind: 'execute',
  readScopes: ['agent-session-context', 'agent-tool-space'],
  writeScopes: ['agent-subagents', 'agent-background-jobs'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'sub-agent dispatch execution',
} satisfies ToolCapabilitySchema

/** 多节点 Workflow 会统一编排、归约并更新一组子 Agent 执行。 */
export const AgentWorkflowCapability = {
  effectKind: 'execute',
  readScopes: ['agent-session-context', 'agent-tool-space'],
  writeScopes: ['agent-subagents', 'agent-background-jobs'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'multi-agent workflow execution',
} satisfies ToolCapabilitySchema

/** 当前 session 后台 job 状态与输出读取。 */
export const AgentBackgroundJobReadCapability = {
  effectKind: 'read',
  readScopes: ['agent-background-jobs'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent background job read',
} satisfies ToolCapabilitySchema

/** 中断当前 session 的后台 Agent 执行。 */
export const AgentBackgroundJobCancelCapability = {
  effectKind: 'execute',
  readScopes: ['agent-background-jobs'],
  writeScopes: ['agent-background-jobs', 'agent-subagents'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent background job cancellation',
} satisfies ToolCapabilitySchema

/** 向用户展示确认或会话交接决策，并等待宿主交互结果。 */
export const AgentUserInteractionCapability = {
  effectKind: 'external',
  writeScopes: ['user-interaction', 'agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent user interaction request',
} satisfies ToolCapabilitySchema
