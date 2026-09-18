/**
 * 根入口（`@velaros-ai/ui/html-artifacts`）：三件能力——增量协议、沙箱文档、浏览器宿主，外加它们用到的数据。
 * 整条引用链不碰 Node 模块，渲染进程与浏览器扩展都能加载。
 * 另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 注入面：宿主可以换掉的浏览器边界 ─────────────────────────────
export type { HtmlArtifactBrowserEnvironment } from './contract/requires.js'

// ── 浏览器宿主这一面的数据 ──────────────────────────────────────
export type { HtmlArtifactHostError, MountHtmlArtifactOptions } from './types/browser.js'

// ── 产品面：增量协议 ────────────────────────────────────────────
export type { HtmlArtifactProtocolApi } from './impl/HtmlArtifactProtocol.js'
export { htmlArtifactProtocol } from './impl/HtmlArtifactProtocol.js'
export type { HtmlArtifactProtocolParserApi } from './impl/HtmlArtifactProtocolParser.js'

// ── 产品面：沙箱文档 ────────────────────────────────────────────
export type { HtmlArtifactDocumentsApi } from './impl/HtmlArtifactDocuments.js'
export { htmlArtifactDocuments } from './impl/HtmlArtifactDocuments.js'

// ── 产品面：浏览器宿主 ──────────────────────────────────────────
export type { HtmlArtifactController } from './impl/HtmlArtifactRuntime.js'
export { mountHtmlArtifact } from './impl/HtmlArtifactRuntime.js'
