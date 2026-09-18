/**
 * 注入面：空间必须塞进来的东西。本单元只从这里接收外部能力，别处不留钩子。
 *
 * - 调用上下文 `KnowledgeOperationContext`：必须。空间每次分发 `velar:knowledge` 的调用时给，里面是取消信号与空间端口 `KnowledgeSpacePort`。
 *
 * 知识库本身（摄入、分块、全文加向量的混合检索、嵌入）不在本单元，在 `@velaros-ai/knowledge`：宿主拿它的领域门面
 * （`createKnowledgeRuntime(...).knowledgeDomainService`）实现端口的三个知识方法，再加上空间自己定工作区的那一个。
 *
 * 这里的每个接口都必须从入口导出。
 */

import type {
  KnowledgeIndexDiagnostics,
  KnowledgeSearchRecord,
  KnowledgeSearchRequest,
  KnowledgeSynced,
} from '../types/knowledge.js'

/** 每次调用拿到的上下文：取消信号与空间端口。 */
export interface KnowledgeOperationContext {
  /** 本次调用的取消信号；用户取消或上层超时时触发，操作和宿主都要尽快收手。 */
  abortSignal: AbortSignal
  /** 空间端口：操作经它定工作区、向知识库要检索、同步与诊断，写作 `ctx.knowledge`。 */
  knowledge: KnowledgeSpacePort
}

/**
 * 空间端口：`velar:knowledge` 的操作在运行时能向空间要什么，写作 `ctx.knowledge`。全仓唯一权威。
 *
 * 后三个方法的名字与形状就是知识库领域门面的那三个，宿主直接转过去；`resolveWorkspace` 是空间自己的决定。
 * 端口里只有操作真会调的方法，门禁按操作文件核对。
 */
export interface KnowledgeSpacePort {
  /**
   * 这次检索、同步落在哪个工作区：给了就按空间的规矩解析（比如相对路径、`~`）；没给用空间自己的（项目空间是项目根）。
   * 空间没有默认工作区、调用又没给时抛 `VALIDATION`，说清要给 workspaceRoot——不猜一个根，也不跨根兜底。
   */
  resolveWorkspace(requested: Optional<string>): string | Promise<string>
  /** 只读诊断：文档总量、各状态的数量、当前嵌入模型的覆盖、各工作区最近同步时刻。 */
  getDiagnostics(): Promise<KnowledgeIndexDiagnostics>
  /** 确保这个工作区的文档与代码知识已经同步，带短时节流；force 为真时跳过节流。 */
  ensureWorkspaceSynced(workspaceRoot: string, options?: { force?: boolean }): Promise<KnowledgeSynced>
  /** 在已建的索引里做一次混合检索，纯读路径：不同步、不重建。 */
  searchKnowledge(query: string, options: KnowledgeSearchRequest): Promise<KnowledgeSearchRecord[]>
}
