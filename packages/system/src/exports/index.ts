/**
 * 系统空间根入口（`@velaros-ai/system`），给 Node 宿主。
 *
 * 只出三样东西：产品面（`interface/provides.ts` 的接口和它们的实例）、注入面（`interface/requires.ts` 的接口）、
 * 以及它们用到的数据（`contract/`）。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 * 跨平台兼容层与共享资源目录在 `@velaros-ai/platform`。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：工具、内置 mod、内核挂载、本地内核、命令策略 ─────────
export { createLocalSystemKernel } from '../impl/LocalSystemKernel.js'
export { systemCommandPolicy } from '../impl/SystemCommandPolicy.js'
export { createSystemBundledModDefinition, createSystemKernelModule, SystemCapability, systemTools } from '../impl/SystemTools.js'
export type {
  LocalSystemKernelApi,
  SystemBundledModDefinition,
  SystemCapabilityService,
  SystemCommandPolicyApi,
  SystemToolCollection,
  VelaTool,
} from '../interface/provides.js'

// ── 注入面：宿主要给的东西 ──────────────────────────────────────
export type {
  CreateSystemKernelModuleOptions,
  LocalSystemKernelOptions,
  SystemProcessConfinementProvider,
  SystemToolContext,
  SystemToolContextResolver,
  SystemToolSystemApi,
} from '../interface/requires.js'

// ── 上面两面用到、又不在可移植文件里的数据 ───────────────────────
export type {
  SystemCommandExecutionPlan,
  SystemProcessConfinementPolicy,
  SystemProcessConfinementRequest,
  SystemProcessConfinementResult,
} from '../contract/commands.js'
