/**
 * execution 宿主入口：命令策略、审批请求、进程与终端契约。
 * 可移植入口只导出本机实现的类型；Node 工厂从 ./local 导入。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：命令策略、危险命令审批请求、execution 宿主 ──────────────
export type { ShellCommandApprovalApi } from './impl/ShellCommandApproval.js'
export { shellCommandApproval } from './impl/ShellCommandApproval.js'
export type { ShellCommandPolicyApi } from './impl/ShellCommandPolicy.js'
export { shellCommandPolicy } from './impl/ShellCommandPolicy.js'

// ── 产品面：本机实现的接口（值在 `./local` 入口）──────────────────
export type { ConfinedShellRunnerApi } from './impl/local/ConfinedShellRunner.js'
export type { LocalShellHostApi } from './impl/local/LocalShellHost.js'

// ── 注入面：空间要给的东西，与本机实现的配置 ──────────────────────
export type {
  ConfinedShellRunnerOptions,
  LocalShellHostOptions,
  ShellHostPort,
  ShellProcessConfinementProvider,
  ShellRunCommandHooks,
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
