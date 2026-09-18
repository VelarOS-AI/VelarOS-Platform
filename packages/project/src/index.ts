/**
 * 项目空间根入口（`@velaros-ai/project`），给 Node 宿主。
 *
 * 只出三样东西：产品面（`contract/provides.ts` 登记的接口和它们的实例、工厂）、注入面（`contract/requires.ts` 的接口）、
 * 以及它们用到的数据（`types/`）与常量表（`contract/constants.ts`）。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 * 能力本身在 `@velaros-ai/velar` 里：项目独有的两件与项目内核在 `@velaros-ai/velar/project`，共用的在 `@velaros-ai/velar/shell`、`sandbox`、`images`。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：项目空间、验证判据 ───────────────────────────────────
export type { ProjectSpaceApi } from './impl/ProjectSpace.js'
export { createProjectSpace } from './impl/ProjectSpace.js'
export type { ProjectVerificationPolicyApi } from './impl/ProjectVerificationPolicy.js'
export { projectVerificationPolicy } from './impl/ProjectVerificationPolicy.js'

// ── 注入面：宿主要给的东西 ──────────────────────────────────────
export type { ProjectCallContext, ProjectHostPort, ProjectSandboxPort } from './contract/requires.js'

// ── 上面两面用到、又不在可移植文件里的数据 ───────────────────────
export type { ProjectSandboxRunOptions } from './types/host.js'
