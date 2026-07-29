import type { ChatMessage, StreamWorkerThreadPayload } from '#contracts'

/**
 * `ConversationWorkerThread` — 子 agent 线程在渲染门面边界的**完整投影**（替换批 5 步 4 的
 * `{ threadId }` stub）。
 *
 * worker-thread 面板本体（`abortSubAgentWorker` / `relaySubAgentGuidance` 等 rendererIpc 站点）
 * 留在宿主，经 `workerThreadPanel` render-slot 注入；管线组件只在此边界持有线程数据。字段面**镜像**
 * 宿主 `ChatWorkerThread`（全部为 Conversation UI 纯展示基元），因此宿主线程与本投影**结构互相
 * 可赋值**——desktop 边界的 `toConversationWorkerThread` 是零丢失映射，slot 实现处不再需要
 * `as ChatWorkerThread[]` 强转（渲染切片=线程全量，面板消费全部字段，非整桶透传）。WS2 会话权威
 * 搬迁后权威源接口若变，只改 desktop 边界映射，本投影不动。
 */
export interface ConversationWorkerThread {
  threadId: string
  activationId?: string
  taskId: Nullable<string>
  nodeId: Nullable<string>
  title: string
  agentName: Nullable<string>
  roleId: Nullable<StreamWorkerThreadPayload['roleId']>
  phase: Nullable<StreamWorkerThreadPayload['phase']>
  status: Nullable<StreamWorkerThreadPayload['status']>
  workspaceTarget: Nullable<StreamWorkerThreadPayload['workspaceTarget']>
  dag: Nullable<StreamWorkerThreadPayload['dag']>
  subagentType: Nullable<string>
  customAgentName: Nullable<string>
  mode: Nullable<StreamWorkerThreadPayload['mode']>
  model: Nullable<string>
  startedAt: number
  updatedAt: number
  input: Nullable<string>
  output: Nullable<string>
  summary: Nullable<string>
  error: Nullable<string>
  messages: ChatMessage[]
}
