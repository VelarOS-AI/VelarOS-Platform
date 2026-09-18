/**
 * 路径规则根入口（`@velaros-ai/core/path-rules`），给 Node 宿主：glob 匹配、.gitignore 的解析与判定、遍历时的忽略策略。
 * 另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 注入面：问 git 的执行口 ──────────────────────────────────────
export type { GitCheckIgnoreRunner } from './contract/requires.js'

// ── 产品面：glob 匹配、.gitignore 判定、遍历忽略策略 ─────────────
export type { GitignoreRulesApi } from './impl/GitignoreRules.js'
export { gitignoreRules } from './impl/GitignoreRules.js'
export type { IgnorePolicyApi } from './impl/IgnorePolicy.js'
export { createIgnorePolicy } from './impl/IgnorePolicy.js'
export type { PathMatcherApi } from './impl/PathMatcher.js'
export { pathMatcher } from './impl/PathMatcher.js'
export type { IgnorePolicyOptions } from './types/options.js'
