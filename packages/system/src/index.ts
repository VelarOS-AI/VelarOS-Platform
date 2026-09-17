/**
 * 系统空间根入口（`@velaros-ai/system`），给 Node 宿主。
 *
 * 只出三样东西：产品面（`contract/provides.ts` 登记的接口和它们的实例）、注入面（`contract/requires.ts` 的接口）、
 * 以及它们用到的数据（`types/`）与常量表（`contract/constants.ts`）。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 * 跨平台兼容层与共享资源目录在 `@velaros-ai/platform`。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：代码面、本地内核 ─────────────────────────────────────
export type { LocalSystemKernelApi } from './impl/LocalSystemKernel.js'
export { createLocalSystemKernel } from './impl/LocalSystemKernel.js'
export type { SystemCodeSurfaceApi } from './impl/SystemCodeSurface.js'
export { createSystemCodeSurface } from './impl/SystemCodeSurface.js'

// ── 注入面：宿主要给的东西 ──────────────────────────────────────
export type { LocalSystemKernelOptions, SystemProcessConfinementProvider, SystemToolContext, SystemToolSystemApi } from './contract/requires.js'

// ── 上面两面用到、又不在可移植文件里的数据 ───────────────────────
export type { SystemProcessConfinementPolicy, SystemProcessConfinementRequest, SystemProcessConfinementResult } from './types/commands.js'
