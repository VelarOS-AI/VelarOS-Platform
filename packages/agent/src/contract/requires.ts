import { z } from 'zod'

export const AgentSessionLifecycleStatusSchema = z.enum([
  'idle',
  'running',
  'interrupted',
  'failed',
])
export type AgentSessionLifecycleStatus = z.infer<typeof AgentSessionLifecycleStatusSchema>

export const AgentBackgroundAgentStateSchema = z.enum([
  'starting',
  'running',
  'completed',
  'failed',
  'stopped',
  'interrupted',
])
export type AgentBackgroundAgentState = z.infer<typeof AgentBackgroundAgentStateSchema>

/**
 * Agent 产品公共的 Session catalog 投影。kind 与 productData 是开放产品轴；Platform
 * 只拥有身份、谱系、生命周期、归档和时间戳这些跨产品不变量。
 */
export interface AgentSessionMetadata<TProductData = unknown> {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly parentSessionId: Nullable<string>
  readonly status: AgentSessionLifecycleStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: Nullable<number>
  readonly productData: TProductData
}

export interface CreateAgentSessionMetadataInput<TProductData = unknown> {
  readonly id?: string
  readonly title?: string
  readonly kind: string
  readonly parentSessionId?: LooseOptional<string>
  readonly productData: TProductData
}

export interface AgentSessionCatalogQuery {
  readonly includeArchived?: boolean
  readonly limit?: number
}

/** 产品持久化实现（SQLite/文件/Cloud）必须适配的公共 Session application port。 */
export interface AgentSessionCatalogPort<TSession extends AgentSessionMetadata = AgentSessionMetadata> {
  create(input: CreateAgentSessionMetadataInput<TSession['productData']>): Promise<TSession> | TSession
  get(id: string): Promise<Nullable<TSession>> | Nullable<TSession>
  list(query?: AgentSessionCatalogQuery): Promise<readonly TSession[]> | readonly TSession[]
  archive(id: string): Promise<TSession> | TSession
  restore(id: string): Promise<TSession> | TSession
}

export interface AgentSessionLease {
  readonly sessionId: string
  readonly ownerId: string
  readonly ownerPid: number
  readonly acquiredAt: number
  readonly heartbeatAt: number
}

export interface AgentSessionLeaseClaim {
  readonly sessionId: string
  readonly ownerId: string
  readonly ownerPid: number
}

export interface AgentSessionLeasePort {
  get(sessionId: string): Promise<Nullable<AgentSessionLease>> | Nullable<AgentSessionLease>
  claim(input: AgentSessionLeaseClaim): Promise<AgentSessionLease> | AgentSessionLease
  heartbeat(sessionId: string, ownerId: string): Promise<AgentSessionLease> | AgentSessionLease
  release(sessionId: string, ownerId: string): Promise<void> | void
}

export interface AgentSessionResourceReference {
  readonly id: string
  readonly kind: string
  readonly uri: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface AgentBackgroundAgent {
  readonly id: string
  readonly sessionId: string
  readonly title: string
  readonly pid: Nullable<number>
  readonly state: AgentBackgroundAgentState
  readonly startedAt: number
  readonly updatedAt: number
  readonly completedAt: Nullable<number>
  readonly exitCode: Nullable<number>
}

export interface AgentBackgroundAgentPort<TAgent extends AgentBackgroundAgent = AgentBackgroundAgent> {
  get(id: string): Promise<Nullable<TAgent>> | Nullable<TAgent>
  list(input?: { includeCompleted?: boolean; limit?: number }): Promise<readonly TAgent[]> | readonly TAgent[]
  markRunning(id: string, pid: number): Promise<TAgent> | TAgent
  finish(
    id: string,
    state: Extract<AgentBackgroundAgentState, 'completed' | 'failed' | 'stopped' | 'interrupted'>,
    exitCode?: LooseOptional<number>
  ): Promise<TAgent> | TAgent
}

export interface AgentBackgroundAgentControlPort<TAgent extends AgentBackgroundAgent = AgentBackgroundAgent>
  extends AgentBackgroundAgentPort<TAgent> {
  start(input: {
    readonly sessionId: string
    readonly title: string
    readonly payload: unknown
  }): Promise<TAgent> | TAgent
  send(id: string, payload: unknown): Promise<void> | void
  wait(id: string, options?: { readonly timeoutMs?: number }): Promise<TAgent>
  stop(id: string): Promise<TAgent> | TAgent
}
