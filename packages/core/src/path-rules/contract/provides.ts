/**
 * 产品面：本包交给外面的三件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发。
 * 注入面在 `requires.ts`：只有一个问 git 的执行口。这里的每个接口都必须从根入口导出。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { GitignoreRulesApi } from '../impl/GitignoreRules.js'
export type { IgnorePolicyApi } from '../impl/IgnorePolicy.js'
export type { PathMatcherApi } from '../impl/PathMatcher.js'
