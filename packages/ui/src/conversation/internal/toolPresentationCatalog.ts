import type { ToolActivityKind, ToolRenderKind } from '#contracts'

interface ToolPresentationMetadata {
  leadingKind: ToolRenderKind
  activityKinds?: readonly ToolActivityKind[]
  dedicatedRender?: boolean
}

const metadata = (
  leadingKind: ToolRenderKind,
  activityKinds?: readonly ToolActivityKind[],
  dedicatedRender?: boolean
): ToolPresentationMetadata => ({ leadingKind, activityKinds, dedicatedRender })

/**
 * UI 自己维护展示语义；运行时暴露、权限与工具执行均留在包外。
 * 产品适配层可以独立演进，组件库只维护稳定的视觉词汇。
 */
const ToolPresentationByName: Readonly<Record<string, ToolPresentationMetadata>> = {
  'tooling:map': metadata('tool-map'),
  'tooling:read': metadata('tool-read'),
  'tooling:replace': metadata('tool-replace'),
  'interaction:show_action_cards': metadata('user-action', ['user-input'], true),
  'interaction:ask_user': metadata('user-action', ['user-input'], true),
  'interaction:read_me': metadata('search'),
  'interaction:confirm': metadata('user-confirmation', ['user-confirmation']),
  'plan:update': metadata('plan', undefined, true),
  'plan:get': metadata('plan'),
  'goal:get': metadata('goal'),
  'goal:create': metadata('goal', undefined, true),
  'goal:update': metadata('goal', undefined, true),
  'proposal:get': metadata('plan'),
  'proposal:review': metadata('plan', undefined, true),
  'context:recall': metadata('search', ['search']),
  'context:distill': metadata('memory'),
  'directive:list': metadata('active-directive'),
  'directive:upsert': metadata('active-directive'),
  'directive:archive': metadata('archive'),
  'agent:dispatch': metadata('agent-dispatch'),
  'project:read': metadata('read-local', ['direct-file-read']),
  'project:search': metadata('search', ['search']),
  'project:list': metadata('list-files', ['search']),
  'project:edit': metadata('file-change', ['file-change'], true),
  'project:rollback': metadata('edit-rollback', ['file-change'], true),
  'project:run': metadata('command', ['command'], true),
  'development:query-code': metadata('search', ['search']),
  'web:search': metadata('search', undefined, true),
  'web:read': metadata('browse-remote', undefined, true),
  'artifact:produce': metadata('artifact', undefined, true),
  'ui:show_widget': metadata('widget', undefined, true),
  'memory:save': metadata('memory'),
  'memory:search': metadata('memory', undefined, true),
  'memory:get': metadata('memory'),
  'memory:archive': metadata('archive'),
  'knowledge:diagnostics': metadata('knowledge'),
  'knowledge:sync': metadata('knowledge'),
  'knowledge:search': metadata('search', ['search']),
}

const PrefixKinds: ReadonlyArray<readonly [string, ToolRenderKind]> = [
  ['browser:', 'browser'],
  ['computer:', 'system'],
  ['game:', 'generic'],
  ['office:', 'office-doc'],
  ['system:', 'system'],
]

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase()
}

export function inferToolRenderKind(toolName: string): ToolRenderKind {
  const normalized = normalizeToolName(toolName)
  const exact = ToolPresentationByName[normalized]?.leadingKind
  if (exact) return exact
  return PrefixKinds.find(([prefix]) => normalized.startsWith(prefix))?.[1] ?? 'generic'
}

export function hasToolActivityKind(toolName: string, kind: ToolActivityKind): boolean {
  return !!ToolPresentationByName[normalizeToolName(toolName)]?.activityKinds?.includes(kind)
}

export function getToolNamesByActivityKind(kind: ToolActivityKind): string[] {
  return Object.entries(ToolPresentationByName)
    .filter(([, value]) => value.activityKinds?.includes(kind))
    .map(([name]) => name)
}

export function getToolNamesByRenderKind(kind: ToolRenderKind): string[] {
  return Object.entries(ToolPresentationByName)
    .filter(([, value]) => value.leadingKind === kind)
    .map(([name]) => name)
}

export function hasDedicatedToolRender(toolName: string): boolean {
  return !!ToolPresentationByName[normalizeToolName(toolName)]?.dedicatedRender
}
