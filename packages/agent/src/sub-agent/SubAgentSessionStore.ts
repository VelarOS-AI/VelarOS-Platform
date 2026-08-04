import type { ModelMessage } from 'ai'

import type {
  SubAgentSessionRecord,
  SubAgentSessionStatus,
  SubAgentTaskMode,
  SubAgentTaskRequest,
  SubAgentTaskResult,
  SubAgentTypeId,
  TeamModelRouteCategory,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'
import { toNullable,toOptional } from '@velaros-ai/core'

interface CreateSubAgentSessionInput {
  threadId: string
  executionId: string
  parentSessionId: string
  subagentType: SubAgentTypeId
  prompt: string
  description?: LooseOptional<string>
  mode?: SubAgentTaskMode
  readonly?: boolean
  toolScope?: SubAgentTaskRequest['tool_scope']
  toolCategories?: readonly ToolCategoryId[]
  model?: LooseOptional<string>
  routeCategory?: LooseOptional<TeamModelRouteCategory>
  agentName?: string
  request?: Partial<Omit<SubAgentTaskRequest, 'subagent_type' | 'prompt'>>
}

/**
 * 单次 execution 内子 Agent 会话内存存储。
 */
class SubAgentSessionStore {
  private readonly sessions = new Map<string, SubAgentSessionRecord>()
  private readonly historyByThread = new Map<string, ModelMessage[]>()
  private readonly executionIndex = new Map<string, Set<string>>()

  public createSession(input: CreateSubAgentSessionInput): SubAgentSessionRecord {
    const now = Date.now()
    const request: SubAgentTaskRequest = {
      subagent_type: input.subagentType,
      prompt: input.prompt,
      description: input.description,
      tool_scope: input.toolScope,
      tool_categories: input.toolCategories ? [...input.toolCategories] : undefined,
      mode: input.mode ?? 'sync',
      readonly: input.readonly,
      model: toOptional(input.model),
      route_category: toOptional(input.routeCategory),
      agent_name: input.agentName,
      ...input.request,
    }
    const record: SubAgentSessionRecord = {
      thread_id: input.threadId,
      execution_id: input.executionId,
      parent_session_id: input.parentSessionId,
      subagent_type: input.subagentType,
      status: 'pending',
      created_at: now,
      updated_at: now,
      request,
      results: [],
    }
    this.sessions.set(input.threadId, record)
    this.historyByThread.set(input.threadId, [])
    const threads = this.executionIndex.get(input.executionId) ?? new Set<string>()
    threads.add(input.threadId)
    this.executionIndex.set(input.executionId, threads)
    return record
  }

  public getSession(threadId: string): Nullable<SubAgentSessionRecord> {
    return toNullable(this.sessions.get(threadId))
  }

  public updateSession(
    threadId: string,
    patch: {
      status?: SubAgentSessionStatus
      request?: Partial<SubAgentTaskRequest>
    }
  ): Nullable<SubAgentSessionRecord> {
    const existing = this.sessions.get(threadId)
    if (!existing) return null
    const updated: SubAgentSessionRecord = {
      ...existing,
      ...patch,
      request: patch.request ? { ...existing.request, ...patch.request } : existing.request,
      updated_at: Date.now(),
    }
    this.sessions.set(threadId, updated)
    return updated
  }

  public appendRunResult(threadId: string, result: SubAgentTaskResult): void {
    const existing = this.sessions.get(threadId)
    if (!existing) return
    existing.results.push(result)
    existing.updated_at = Date.now()
    this.sessions.set(threadId, existing)
  }

  public getHistory(threadId: string): ModelMessage[] {
    return [...(this.historyByThread.get(threadId) ?? [])]
  }

  public setHistory(threadId: string, history: ModelMessage[]): void {
    this.historyByThread.set(threadId, [...history])
    const session = this.sessions.get(threadId)
    if (session) {
      session.updated_at = Date.now()
      this.sessions.set(threadId, session)
    }
  }

  public listByExecution(executionId: string): SubAgentSessionRecord[] {
    const threadIds = this.executionIndex.get(executionId)
    if (!threadIds) return []
    return [...threadIds]
      .map((threadId) => this.sessions.get(threadId))
      .filter((session): session is SubAgentSessionRecord => !!session)
  }

  public clearExecution(executionId: string): void {
    const threadIds = this.executionIndex.get(executionId)
    if (!threadIds) return
    for (const threadId of threadIds) {
      this.sessions.delete(threadId)
      this.historyByThread.delete(threadId)
    }
    this.executionIndex.delete(executionId)
  }

  public setStatus(threadId: string, status: SubAgentSessionStatus): void {
    this.updateSession(threadId, { status })
  }
}

export { SubAgentSessionStore }
export type { CreateSubAgentSessionInput }
