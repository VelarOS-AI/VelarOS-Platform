import {
  getToolNamesByActivityKind,
  getToolNamesByRenderKind,
  hasDedicatedToolRender,
} from '#internal/toolPresentationCatalog'

/**
 * 工具渲染注册用的工具名集合——从 UI 自有工具展示元数据目录派生。
 *
 * 原 desktop `@shared/constants/toolRendering` 的 render-kind 派生随 tool-render 原子入包；宿主
 * compat 层只保留其活动种类等宿主自用面。专属渲染名一律 `.filter(hasDedicatedToolRender)`。
 */
export const CommandToolNames = getToolNamesByActivityKind('command')
export const FileChangeToolNames = getToolNamesByActivityKind('file-change')

export const PlanToolNames = getToolNamesByRenderKind('plan').filter(hasDedicatedToolRender)
export const GoalToolNames = getToolNamesByRenderKind('goal').filter(hasDedicatedToolRender)
export const SearchResultRenderToolNames = getToolNamesByRenderKind('search').filter(
  hasDedicatedToolRender
)
export const WebReadRenderToolNames = getToolNamesByRenderKind('browse-remote').filter(
  hasDedicatedToolRender
)
export const ArtifactRenderToolNames = getToolNamesByRenderKind('artifact').filter(
  hasDedicatedToolRender
)
export const MemoryRecallRenderToolNames = getToolNamesByRenderKind('memory').filter(
  hasDedicatedToolRender
)
export const SystemToolInstallToolNames = getToolNamesByRenderKind('install').filter(
  hasDedicatedToolRender
)

export const WidgetRenderToolNames = getToolNamesByRenderKind('widget').filter(
  hasDedicatedToolRender
)

/**
 * Plan / Goal 的完整状态卡归会话 sticky dock 独占；transcript 只保留它们真实发生过的工具调用行。
 * 这里是两种展示形态的单一边界，避免会话壳和 ToolCallBlock 各维护一份名字清单。
 */
const StickyDockOwnedToolNameSet = new Set(['plan:update', 'goal:create', 'goal:update'])

export function shouldUseDefaultTranscriptToolRenderer(toolName: string): boolean {
  return StickyDockOwnedToolNameSet.has(toolName.trim().toLowerCase())
}
