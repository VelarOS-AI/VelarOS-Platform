/**
 * 可移植数据入口（`@velaros-ai/knowledge/contracts`）：知识库经宿主端口流动的全部数据类型。
 *
 * 只有类型，没有运行时 JavaScript，也没有任何 Node 依赖——浏览器、渲染进程与 IPC 契约都能 import。
 * `SQLite`、`LanceDB`、摄入、工具与运行时实现仍由包根入口提供。
 */
export type * from '../types/knowledge.js'
