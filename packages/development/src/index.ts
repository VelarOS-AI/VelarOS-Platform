/**
 * 根入口（`@velaros-ai/development`）：语言查询、代码查询工厂、外部语言服务与 TypeScript 项目池。
 * 要读磁盘、要拉子进程，只给 Node；另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 注入面：宿主要塞进来的东西 ───────────────────────────────────
export type { LanguageReadPort, LanguageToolContext, ProjectCodeIndexApi } from './contract/requires.js'

// ── 产品面：语言查询 ─────────────────────────────────────────────
export type { LanguageQueriesApi } from './impl/LanguageQueries.js'
export { languageQueries } from './impl/LanguageQueries.js'

// ── 产品面：project 的 queryCode ─────────────────────────────────
export { createProjectCodeQuery } from './impl/ProjectCodeQuery.js'

// ── 产品面：外部语言服务 ─────────────────────────────────────────
export type { ExternalLanguageServiceApi } from './impl/ExternalLanguageService.js'
export { createExternalLanguageService } from './impl/ExternalLanguageService.js'

// ── 产品面：TypeScript 项目池 ────────────────────────────────────
export type { TypeScriptProjectsApi } from './impl/TypeScriptProjectPool.js'
export { typeScriptProjects } from './impl/TypeScriptProjectPool.js'
