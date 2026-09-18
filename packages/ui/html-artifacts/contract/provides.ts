/**
 * 产品面：本包交给外面的三件能力。它们的 API 定义在各自类的上方（`impl/` 里，接口紧挨着类），这里登记并转发。
 * 三件能力互相独立：只要协议解析就拿 `htmlArtifactProtocol`，只要造文档就拿 `htmlArtifactDocuments`，
 * 要整套「一个 iframe 接一条流」就拿 `mountHtmlArtifact`。这里的每个接口都必须从根入口导出。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { HtmlArtifactDocumentsApi } from '../impl/HtmlArtifactDocuments.js'
export type { HtmlArtifactProtocolApi } from '../impl/HtmlArtifactProtocol.js'
export type { HtmlArtifactProtocolParserApi } from '../impl/HtmlArtifactProtocolParser.js'
export type { HtmlArtifactController } from '../impl/HtmlArtifactRuntime.js'
