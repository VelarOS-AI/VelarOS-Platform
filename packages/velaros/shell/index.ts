/**
 * shell 能力根入口（`@velaros-ai/velaros/shell`）：命令策略、危险命令审批请求、代码面 `velaros:shell` 的操作，外加它们用到的数据与空间端口，
 * 以及本机实现（`./local` 入口）的接口与配置。根入口整条引用链不碰 Node 模块，渲染进程也能加载（本机实现只导出类型）。
 * 另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：命令策略、危险命令审批请求、velaros:shell ──────────────
export type { ShellCommandApprovalApi } from './impl/ShellCommandApproval.js'
export { shellCommandApproval } from './impl/ShellCommandApproval.js'
export type { ShellCommandPolicyApi } from './impl/ShellCommandPolicy.js'
export { shellCommandPolicy } from './impl/ShellCommandPolicy.js'
export type { ShellOperationsApi } from './impl/ShellOperations.js'
export { shellOperations } from './impl/ShellOperations.js'

// ── 产品面：本机实现的接口（值在 `./local` 入口）──────────────────
export type { ConfinedShellRunnerApi } from './impl/local/ConfinedShellRunner.js'
export type { LocalShellHostApi } from './impl/local/LocalShellHost.js'

// ── 注入面：空间要给的东西，与本机实现的配置 ──────────────────────
export type {
  ConfinedShellRunnerOptions,
  LocalShellHostOptions,
  ShellHostPort,
  ShellOperationContext,
  ShellProcessConfinementProvider,
  ShellRunCommandHooks,
  ShellSpacePort,
  ShellTerminalExit,
  ShellTerminalFactory,
  ShellTerminalProcess,
  ShellTerminalSpawnOptions,
} from './contract/requires.js'

// ── 上面用到、又不在可移植文件里的数据 ───────────────────────────
export type { ShellEnvironmentOptions } from './contract/requires.js'
export type { ShellEnvironmentApi } from './impl/local/ShellEnvironment.js'
export type { ShellCommandApprovalInput, ShellCommandApprovalRequest } from './types/approval.js'
export type {
  ShellProcessConfinementPolicy,
  ShellProcessConfinementRequest,
  ShellProcessConfinementResult,
} from './types/local.js'
export type { ResolvedShell } from './types/local.js'
