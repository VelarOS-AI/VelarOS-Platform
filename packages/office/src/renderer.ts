/**
 * Narrow document-rendering surface for independently packaged renderers.
 *
 * Host products must not import this subpath. It intentionally exposes only
 * parsing and rendering primitives, without Kernel modules or tool catalogs.
 */
export {
  buildOfficePreviewHtml,
  parseOfficePreview,
  renderOfficePreviewPng,
  type OfficePreviewKind,
  type ParsedOfficePreview,
} from './previewTool'
