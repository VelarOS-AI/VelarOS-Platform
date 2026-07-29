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
export const GitCommitsRenderToolNames = getToolNamesByRenderKind('git').filter(
  hasDedicatedToolRender
)
export const SystemToolInstallToolNames = getToolNamesByRenderKind('install').filter(
  hasDedicatedToolRender
)

export const WidgetRenderToolNames = getToolNamesByRenderKind('widget').filter(
  hasDedicatedToolRender
)
