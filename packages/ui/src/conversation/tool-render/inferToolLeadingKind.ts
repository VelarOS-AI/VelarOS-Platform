import type { ToolRenderKind } from '#contracts'
export { inferToolRenderKind as inferToolLeadingKind } from '#internal/toolPresentationCatalog'

/**
 * 紧凑工具行 / 默认工具渲染主图标的视觉分类。
 * 规范映射在 core 的 ToolMetadataCatalog 中维护，renderer 仅保留兼容类型名。
 */
export type ToolLeadingKind = ToolRenderKind
