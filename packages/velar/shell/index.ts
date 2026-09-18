/**
 * shell 能力根入口（`@velaros-ai/velar/shell`）：命令策略、危险命令审批请求、代码面 `velar:shell` 的三个操作，外加它们用到的数据与空间端口。
 * 根入口整条引用链不碰 Node 模块，渲染进程也能加载。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：命令策略、危险命令审批请求、velar:shell ──────────────
export type { ShellCommandApprovalApi } from './impl/ShellCommandApproval.js'
export { shellCommandApproval } from './impl/ShellCommandApproval.js'
export type { ShellCommandPolicyApi } from './impl/ShellCommandPolicy.js'
export { shellCommandPolicy } from './impl/ShellCommandPolicy.js'
export type { ShellOperationsApi } from './impl/ShellOperations.js'
export { shellOperations } from './impl/ShellOperations.js'

// ── 注入面：空间要给的东西 ──────────────────────────────────────
export type { ShellOperationContext, ShellSpacePort } from './contract/requires.js'

// ── 上面用到、又不在可移植文件里的数据 ───────────────────────────
export type { ShellCommandApprovalInput, ShellCommandApprovalRequest } from './types/approval.js'
