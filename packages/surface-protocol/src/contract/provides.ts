/**
 * 产品面：本包交给外面的一件能力。它的 API 定义在类上方（`impl/ProviderSurfaceWire.ts`，接口紧挨着类），这里登记并转发。
 * 没有注入面：本包不需要宿主塞任何东西，只看数据。这里的每个接口都必须从根入口导出。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { ProviderSurfaceWireApi } from '../impl/ProviderSurfaceWire.js'
