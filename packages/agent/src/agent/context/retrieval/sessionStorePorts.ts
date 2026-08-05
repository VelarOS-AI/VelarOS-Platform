import type {
  ChatMessage,
  ChatSessionPayloadSnapshot,
  ChatSessionToolResultPayload,
} from '@velaros-ai/agent/protocol'

/**
 * 检索单元消费的**会话存储窄端口**（宪章 §12.2「SessionStorePort 子接口」）。
 *
 * 只声明本单元实际读到的方法，不设计完整 SessionStorePort（那是 WS2 的活）。
 * 宿主的具体存储类（Desktop 的 `ChatPayloadStore` / `ChatStateStore`）字段更多，
 * 结构化满足这些端口即可注入；内核侧只依赖端口，与宿主持久化实现解耦。
 */

/**
 * payload 读端口：工具结果与消息序列化载荷的按会话读取。
 * `loadToolPayload` 可选——宿主若提供单 blob 直读则走快路径，缺席时退回整包快照扫描。
 */
interface RetrievalPayloadStorePort {
  loadSessionPayloads(sessionId: string): Promise<ChatSessionPayloadSnapshot>
  loadToolPayload?(
    sessionId: string,
    key: string
  ): Promise<Nullable<ChatSessionToolResultPayload>>
}

/**
 * state 读端口：会话消息的按会话读取。
 *
 * 2026-08-06 evidence 流协议链下线：本端口曾多一格 `loadSessionContextSnapshot`，
 * 只为把宿主的 `session.runtime.evidenceLedger` 喂给索引构建。那条账本自始至终没有
 * 生产者（`evidenceExtractors` 两仓零注册），整链已随协议字段一并处决，端口回到
 * 「只读消息」的最小形状。
 */
interface RetrievalStateStorePort {
  loadSessionMessages(sessionId: string): Promise<ChatMessage[]>
  loadSessionMessage(sessionId: string, index: number): Promise<Nullable<ChatMessage>>
}

export { type RetrievalPayloadStorePort, type RetrievalStateStorePort }
