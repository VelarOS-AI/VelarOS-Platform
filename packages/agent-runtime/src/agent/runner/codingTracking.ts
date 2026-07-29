// 域：主 Agent 的**编码追踪 / 会话键**派生（跨轮授权注册表键 + 子 Agent 执行键）。
// 逻辑与原 AgentRunner 内联实现逐字节一致，仅按域拆出为纯函数。
import { normalizeSessionLineageId } from '@velaros-ai/core/utils/sessionLineage'

import type { AgentExecutionConfig } from '../RuntimeConfiguration'

/**
 * 跨轮次工具类别授权注册表的键：surface + session + 血缘（分支/检查点）四元组。
 * 血缘缺省时回退到稳定占位，保证同一会话同一分支的授权状态跨轮延续。
 */
export function buildApprovalRegistryKey(
  surfaceId: string,
  sessionId: string,
  lineage: AgentExecutionConfig['sessionLineage']
): string {
  const branchId = normalizeSessionLineageId(lineage?.activeBranchId) || 'branch:unknown'
  const checkpointId = normalizeSessionLineageId(lineage?.activeCheckpointId) || 'head'
  return `${surfaceId}:${sessionId}:${branchId}:${checkpointId}`
}

/**
 * 子 Agent 派发的执行键：优先用 execution.executionId，缺省时回退到 sessionId 的 chat-stream scope。
 * dispatch() 与 clearExecution() 必须用同一派生，避免键漂移误清其他执行的子 Agent。
 */
export function resolveSubAgentExecutionKey(args: {
  executionId?: LooseOptional<string>
  sessionId: string
}): string {
  const executionId = args.executionId?.trim()
  if (executionId) return executionId
  return args.sessionId
}
