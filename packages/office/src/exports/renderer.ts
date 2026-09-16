/**
 * 供独立打包渲染器使用的窄文档渲染面（`@velaros-ai/office/renderer`）。
 *
 * Host 产品不得导入这个子路径；这里只公开解析与渲染原语，不包含 Kernel 模块或工具目录，
 * 整条值引用链因此不经过工具文件，也就不需要 agent。失败按 `OfficeErrorCodes` 的码判断。
 */
export { OfficeErrorCodes } from '../contract/constants.js'
export type { OfficeDocumentRendererApi } from '../contract/provides.js'
export { officeDocumentRenderer } from '../impl/runtime/OfficeDocumentRenderer.js'
export type { NormalizedWordInput } from '../types/office.js'
export type {
  MammothMessage,
  OfficePreviewKind,
  ParsedOfficePreview,
  PreviewOutlineItem,
  PreviewSheet,
  PreviewSlide,
  RenderedOfficePreviewPng,
  RenderedPdfPagePng,
  RenderPdfPagePngInput,
} from '../types/preview.js'
