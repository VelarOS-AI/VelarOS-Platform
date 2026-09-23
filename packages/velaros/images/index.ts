/**
 * 看图能力根入口（`@velaros-ai/velaros/images`），给 Node 宿主：代码面 `velaros:images` 的 view，外加它用到的数据与空间端口，
 * 以及本机看图端口（`./local` 入口）的配置。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：velaros:images ────────────────────────────────────────
export type { ImageOperationsApi } from './impl/ImageOperations.js'
export { imageOperations } from './impl/ImageOperations.js'

// ── 注入面：空间要给的东西 ──────────────────────────────────────
export type {
  ImageOperationContext,
  ImageSpacePort,
  LocalImagePortOptions,
} from './contract/requires.js'

// ── 上面用到、又不在可移植文件里的数据 ───────────────────────────
export type {
  ImageAttachment,
  ImageLocation,
  ImageResizeRequest,
  ImageResizeResult,
} from './types/space.js'
