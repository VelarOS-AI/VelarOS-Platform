/**
 * 代理面线格式根入口（`@velaros-ai/surface-protocol`）：线格式校验与绑定构造，外加它们用到的数据。
 * 整条引用链不碰 Node 模块，渲染进程与浏览器扩展都能加载。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 产品面：线格式校验与绑定构造 ─────────────────────────────────
export type { ProviderSurfaceWireApi } from './impl/ProviderSurfaceWire.js'
export { providerSurfaceWire } from './impl/ProviderSurfaceWire.js'
