/**
 * 供独立打包渲染器使用的窄文档渲染面。
 *
 * Host 产品不得导入这个子路径；这里只公开解析与渲染原语，不包含 Kernel 模块或工具目录。
 */
export {
  buildOfficePreviewHtml,
  type OfficePreviewKind,
  type ParsedOfficePreview,
  parseOfficePreview,
  renderOfficePreviewPng,
} from './previewTool'
