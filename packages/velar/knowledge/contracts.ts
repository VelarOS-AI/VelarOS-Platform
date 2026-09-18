/**
 * 可移植数据入口（`@velaros-ai/velar/knowledge/contracts`）：常量表（来源类型、索引状态与命中类型、检索上限、索引参数、存储迁移）、
 * 知识库经宿主与空间端口流动的全部数据类型、`velar:knowledge` 的入参与回执；还有随包发布的模型面（`VelarKnowledgeModule`：
 * 模块名、方法、生成的完整声明），空间挂它时交给代码面的门。
 *
 * 没有任何 Node 依赖——浏览器、渲染进程与 IPC 契约都能 import。SQLite、LanceDB、摄入与运行时实现由根入口提供。
 */
export * from './contract/constants.js'
export { VelarKnowledgeModule } from './contract/surface.js'
export type * from './types/knowledge.js'
