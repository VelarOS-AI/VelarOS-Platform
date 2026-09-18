/**
 * 产品面：本包交给外面的能力。类实现的 API 定义在类上方（`impl/` 里，接口紧挨着类），这里登记并转发。
 * 本机实现的工厂在 `./local` 入口（本机文件端口直接实现 requires 里的 `FileSpacePort`，不另起接口）。
 * 空间要塞进来的东西在 `contract/requires.ts`。这里的每个接口都必须从根入口导出。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { FileOperationsApi } from '../impl/FileOperations.js'

// ── 本机实现：工厂在 `./local` 入口 ─────────────────────────────
export type { LocalFileSearchApi } from '../impl/LocalFileSearch.js'
