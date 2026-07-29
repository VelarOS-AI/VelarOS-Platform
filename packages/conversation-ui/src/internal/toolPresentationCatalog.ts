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
 * UI-owned presentation semantics. Runtime exposure, permissions and tool execution stay outside
 * this package; product adapters can evolve independently while this stable visual vocabulary is
 * maintained by the component library.
 */
const ToolPresentationByName: Readonly<Record<string, ToolPresentationMetadata>> = {
  tool_map: metadata('tool-map'),
  tool_read: metadata('tool-read'),
  tool_replace: metadata('tool-replace'),
  workbench_switch_workspace: metadata('workspace-roots'),
  show_user_action_cards: metadata('user-action', ['user-input'], true),
  ask_user: metadata('user-action', ['user-input'], true),
  action_card_read_me: metadata('search'),
  update_plan: metadata('plan', undefined, true),
  get_plan: metadata('plan'),
  get_goal: metadata('goal'),
  create_goal: metadata('goal', undefined, true),
  update_goal: metadata('goal', undefined, true),
  get_proposal: metadata('plan'),
  proposal_review: metadata('plan', undefined, true),
  recall_context: metadata('search', ['search']),
  distill_context: metadata('memory'),
  list_active_directives: metadata('active-directive'),
  upsert_active_directive: metadata('active-directive'),
  archive_active_directive: metadata('archive'),
  bash: metadata('command', ['command'], true),
  ws_run_command: metadata('command', ['command'], true),
  run_verification_plan: metadata('system-tools', ['verification-command']),
  suggest_system_tool_install: metadata('install', undefined, true),
  dispatch_agent: metadata('agent-dispatch'),
  ws_read: metadata('read-local'),
  ws_file_stat: metadata('project-metadata'),
  ws_search: metadata('search', ['search']),
  ws_list_files: metadata('list-files', ['search']),
  ws_diff: metadata('edit-diff'),
  ws_edit: metadata('file-change', ['file-change'], true),
  ws_symbols: metadata('search', ['search']),
  code_graph: metadata('search', ['search']),
  ws_rollback: metadata('edit-rollback', ['file-change'], true),
  web_search: metadata('search', undefined, true),
  web_read: metadata('browse-remote', undefined, true),
  produce_artifact: metadata('artifact', undefined, true),
  get_git_commits: metadata('git', undefined, true),
  git_status: metadata('git'),
  git_diff: metadata('git', ['direct-file-read']),
  read_file: metadata('read-local', ['direct-file-read']),
  read_files: metadata('read-local', ['multi-file-read']),
  read: metadata('read-local', ['direct-file-read']),
  grep: metadata('search', ['search']),
  list: metadata('search'),
  edit: metadata('file-change', ['file-change']),
  write: metadata('file-change', ['file-change']),
  read_symbol: metadata('read-local'),
  move_file: metadata('file-move', ['file-change', 'file-move'], true),
  search_replace_in_files: metadata('refactor', ['file-change'], true),
  rename_symbol: metadata('refactor', ['file-change'], true),
  write_file: metadata('file-change'),
  edit_file: metadata('file-change'),
  delete_file: metadata('file-change'),
  edit_symbol: metadata('file-change'),
  replace_lines: metadata('file-change'),
  add_import: metadata('file-change'),
  analyze_symbol_impact: metadata('search', ['search']),
  find_files: metadata('search', ['search']),
  find_imports: metadata('search', ['search']),
  find_symbols: metadata('search', ['search']),
  find_references: metadata('search', ['search']),
  find_importers: metadata('search', ['search']),
  list_exports: metadata('search', ['search']),
  search_in_files: metadata('search', ['search']),
  search_knowledge: metadata('search', ['search']),
  list_files: metadata('search', ['search']),
  save_memory: metadata('memory'),
  search_memories: metadata('memory', undefined, true),
  get_memory: metadata('memory'),
  archive_memory: metadata('archive'),
  get_knowledge_diagnostics: metadata('knowledge'),
  sync_knowledge_workspace: metadata('knowledge'),
  enter_browser_site: metadata('browser'),
  leave_browser_site: metadata('browser'),
  get_browser_site_context: metadata('browser'),
  get_browser_workspace_manifest: metadata('browser'),
  request_confirmation: metadata('user-confirmation', ['user-confirmation']),
  tool_reflect: metadata('tool-reflect'),
  ps: metadata('system-tools'),
  open: metadata('system-tools'),
  refresh_shell_environment: metadata('system-tools'),
  list_background_tasks: metadata('system-tools'),
  terminate_background_task: metadata('system-tools'),
  associate_processes_with_projects: metadata('system-tools'),
  get_session_edit_log: metadata('system-tools'),
  show_widget: metadata('widget', undefined, true),
  create_word_document: metadata('office-doc'),
  create_spreadsheet: metadata('office-doc'),
  create_presentation: metadata('office-doc'),
  convert_word_to_pdf: metadata('office-doc'),
  convert_pdf_to_word: metadata('office-doc'),
  edit_pdf_document: metadata('office-doc'),
  create_latex_pdf: metadata('office-doc'),
  preview_office_document: metadata('office-doc'),
  convert_document_to_markdown: metadata('office-doc'),
  infer_active_project: metadata('active-project-infer'),
  summarize_current_dev_environment: metadata('dev-environment-summary'),
  workspace_roots: metadata('workspace-roots'),
  discover_projects: metadata('project-catalog'),
  list_recent_projects: metadata('project-catalog'),
  get_project_info: metadata('project-metadata'),
  get_project_context: metadata('project-metadata'),
}

const PrefixKinds: ReadonlyArray<readonly [string, ToolRenderKind]> = [
  ['browser_', 'browser'],
  ['git_', 'git'],
  ['create_word', 'office-doc'],
  ['create_presentation', 'office-doc'],
  ['create_spreadsheet', 'office-doc'],
  ['convert_word', 'office-doc'],
  ['convert_pdf_to_word', 'office-doc'],
  ['create_latex', 'office-doc'],
  ['edit_pdf_document', 'office-doc'],
  ['get_system_', 'system-tools'],
  ['inspect_system', 'system-tools'],
  ['diagnose_dev_runtime', 'system-tools'],
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
