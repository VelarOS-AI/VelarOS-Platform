/**
 * 本机文件能力根入口（`@velaros-ai/velar/files`），给 Node 宿主：代码面 `velar:files` 的三个操作，外加它们用到的数据与空间端口，
 * 以及本机实现（`./local` 入口）的接口与配置。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：velar:files ─────────────────────────────────────────
export type { FileOperationsApi } from './impl/FileOperations.js'
export { fileOperations } from './impl/FileOperations.js'

// ── 产品面：本机实现的接口（值在 `./local` 入口）──────────────────
export type { LocalFileSearchApi } from './impl/LocalFileSearch.js'

// ── 注入面：空间要给的东西 ──────────────────────────────────────
export type { FileOperationContext, FileSpacePort, LocalFilePortOptions, LocalFileSearchOptions } from './contract/requires.js'

// ── 上面用到、又不在可移植文件里的数据 ───────────────────────────
export type { FileWrite } from './types/space.js'
export type { FileReadResult, FileText } from './types/text.js'
