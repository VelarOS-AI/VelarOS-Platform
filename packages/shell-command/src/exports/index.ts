/**
 * 命令语义根入口（`@velaros-ai/shell-command`）：命令策略与危险命令审批请求，外加它们用到的数据。
 * 根入口整条引用链不碰 Node 模块，渲染进程也能加载。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：命令策略、危险命令审批请求 ───────────────────────────
export type { ShellCommandApprovalApi } from '../impl/ShellCommandApproval.js'
export { shellCommandApproval } from '../impl/ShellCommandApproval.js'
export type { ShellCommandPolicyApi } from '../impl/ShellCommandPolicy.js'
export { shellCommandPolicy } from '../impl/ShellCommandPolicy.js'

// ── 上面用到、又不在可移植文件里的数据 ───────────────────────────
export type { ShellCommandApprovalInput, ShellCommandApprovalRequest } from '../types/approval.js'
