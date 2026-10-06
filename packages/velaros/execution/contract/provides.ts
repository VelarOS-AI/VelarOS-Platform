/**
 * 产品面：本单元交给外面的能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发。
 * 命令策略与审批请求从根入口取；本机实现（本机宿主、受约束执行器）的工厂在 `./local` 入口。
 * 空间要塞进来的东西在 `contract/requires.ts`。这里的每个接口都必须从根入口导出。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { ShellCommandApprovalApi } from '../impl/ShellCommandApproval.js'
export type { ShellCommandPolicyApi } from '../impl/ShellCommandPolicy.js'

// ── 本机实现：工厂在 `./local` 入口 ─────────────────────────────
export type { ConfinedShellRunnerApi } from '../impl/local/ConfinedShellRunner.js'
export type { LocalShellHostApi } from '../impl/local/LocalShellHost.js'
export type { ShellEnvironmentApi } from '../impl/local/ShellEnvironment.js'
