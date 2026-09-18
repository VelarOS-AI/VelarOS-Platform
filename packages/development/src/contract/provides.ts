/**
 * 产品面：本包交给外面的三件整件能力。它们的 API 定义在各自类的上方（`impl/`，接口紧挨着类），这里登记并转发。
 * 另有一个工厂 `createProjectCodeQuery`：它的返回类型直接用 project 注入面的成员类型，不需要在这里登记接口。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { ExternalLanguageServiceApi } from '../impl/ExternalLanguageService.js'
export type { LanguageQueriesApi } from '../impl/LanguageQueries.js'
export type { TypeScriptProjectsApi } from '../impl/TypeScriptProjectPool.js'
