/**
 * 演练沙箱根入口（`@velaros-ai/rehearsal-sandbox`）：落回前的核对与确认请求，外加它们用到的数据。
 * 根入口整条引用链不碰 Node 模块，渲染进程也能加载。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：落回规则 ─────────────────────────────────────────────
export type { RehearsalSandboxRulesApi } from '../impl/RehearsalSandboxRules.js'
export { rehearsalSandboxRules } from '../impl/RehearsalSandboxRules.js'

// ── 注入面：宿主要实现的沙箱端口 ────────────────────────────────
export type { RehearsalSandboxHostPort } from '../contract/requires.js'

// ── 上面用到、又不在可移植文件里的数据 ───────────────────────────
export type { SandboxApplyPrepareInput, SandboxApplyRequest } from '../types/apply.js'
