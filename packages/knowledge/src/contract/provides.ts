/**
 * 产品面：本包交给外面的整件能力。
 *
 * 类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里只做登记与转发；
 * 这里登记的每个接口都从根入口导出。没有类的公开接口才直接声明在这里。
 * 包内的分块、行映射、召回拼装、向量查询、嵌入服务与向量告警都是运行时自己装好的零件，
 * 装配者不需要认识它们，所以不登记、也不出包。
 */

// ── 运行时与领域门面 ────────────────────────────────────────────
export type { KnowledgeDomainApi } from '../impl/domain/KnowledgeDomain.js'
export type { KnowledgeRuntimeApi } from '../impl/KnowledgeRuntime.js'

// ── 存储：向量表（宿主做存储迁移与诊断时直接用）与嵌入协议客户端 ──
export type { KnowledgeEmbeddingClientApi } from '../impl/storage/KnowledgeEmbeddingClient.js'
export type { KnowledgeVectorsApi } from '../impl/storage/KnowledgeVectors.js'
