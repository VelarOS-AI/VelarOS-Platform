/**
 * 产品面：本包交给外面的三件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发。
 * 空间要塞进来的东西在 `contract/requires.ts`。这里的每个接口都必须从根入口导出。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { ShellCommandApprovalApi } from '../impl/ShellCommandApproval.js'
export type { ShellCommandPolicyApi } from '../impl/ShellCommandPolicy.js'
export type { ShellOperationsApi } from '../impl/ShellOperations.js'
